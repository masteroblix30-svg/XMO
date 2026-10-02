'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'localconfig.json');
const INDEX_FILE = path.join(ROOT, 'index.html');
const ADS_FILE = path.join(ROOT, 'ads.js');

const PUBLIC_ASSETS = Object.freeze({
  '/': INDEX_FILE,
  '/index.html': INDEX_FILE,
  '/ads.js': ADS_FILE
});

const DEFAULTS = {
  serverLoginUrl: '',
  resetGuest: true,
  resetGuestOnLaunch: false,
  port: 8080,
  host: '127.0.0.1',
  gameToken: '',
  corsOrigins: ['*'],
  sessionTtlMs: 900000,
  storeFile: 'data/sessions.json',
  releaseUrl: '',
  uidMinLength: 8,
  uidMaxLength: 12,
  rateLimit: { windowMs: 60000, max: 60 }
};

const STATES = Object.freeze({
  PENDING: 'pending',
  AUTHORIZED: 'authorized',
  ACTIVE: 'active',
  REVOKED: 'revoked'
});

const config = loadConfig();
const STORE_PATH = path.resolve(ROOT, config.storeFile);
const records = new Map();
const hits = new Map();

function loadConfig() {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    console.error('[config] cannot read localconfig.json ->', err.message);
  }
  const merged = { ...DEFAULTS, ...parsed };
  merged.rateLimit = { ...DEFAULTS.rateLimit, ...(parsed.rateLimit || {}) };
  if (!Array.isArray(merged.corsOrigins) || merged.corsOrigins.length === 0) {
    merged.corsOrigins = ['*'];
  }
  merged.uidMinLength = Number(merged.uidMinLength) || DEFAULTS.uidMinLength;
  merged.uidMaxLength = Number(merged.uidMaxLength) || DEFAULTS.uidMaxLength;
  return merged;
}

function uidPattern() {
  return new RegExp('^[0-9]{' + config.uidMinLength + ',' + config.uidMaxLength + '}$');
}

function validateUid(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string') return null;
  const uid = value.trim().replace(/[\s-]/g, '');
  if (!uidPattern().test(uid)) return null;
  return uid;
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.records || [];
    for (const record of list) {
      if (record && typeof record.uid === 'string' && uidPattern().test(record.uid)) {
        records.set(record.uid, normalizeRecord(record));
      }
    }
    console.log('[store] restored ' + records.size + ' record(s) from ' + config.storeFile);
  } catch (err) {
    console.error('[store] cannot read ' + config.storeFile + ' ->', err.message);
  }
}

function normalizeRecord(record) {
  return {
    uid: record.uid,
    state: STATES[record.state] || STATES.PENDING,
    slot: Number(record.slot) || null,
    note: typeof record.note === 'string' ? record.note : '',
    clientVersion: record.clientVersion || null,
    deviceId: record.deviceId || null,
    challenge: record.challenge || null,
    authorizationToken: record.authorizationToken || null,
    activationToken: record.activationToken || null,
    createdAt: record.createdAt || new Date().toISOString(),
    authorizedAt: record.authorizedAt || null,
    activatedAt: record.activatedAt || null,
    lastSeenAt: record.lastSeenAt || record.createdAt || new Date().toISOString()
  };
}

function persistStore() {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      service: 'exter-minatos',
      serverLoginUrl: config.serverLoginUrl,
      count: records.size,
      records: Array.from(records.values())
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.error('[store] cannot write ' + config.storeFile + ' ->', err.message);
  }
}

function isExpired(record) {
  return Date.now() - Date.parse(record.lastSeenAt) > config.sessionTtlMs;
}

function pruneExpired() {
  let removed = 0;
  for (const [uid, record] of records) {
    if (isExpired(record)) {
      records.delete(uid);
      removed += 1;
    }
  }
  return removed;
}

function publicRecord(record) {
  return {
    uid: record.uid,
    state: record.state,
    slot: record.slot,
    note: record.note,
    clientVersion: record.clientVersion,
    deviceId: record.deviceId,
    createdAt: record.createdAt,
    authorizedAt: record.authorizedAt,
    activatedAt: record.activatedAt,
    lastSeenAt: record.lastSeenAt,
    expiresAt: new Date(Date.parse(record.lastSeenAt) + config.sessionTtlMs).toISOString()
  };
}

function upsert(uid, patch) {
  const existing = records.get(uid);
  const now = new Date().toISOString();
  const base = existing ? { ...existing } : normalizeRecord({ uid: uid });
  const next = { ...base, ...patch, uid: uid, lastSeenAt: now };
  records.set(uid, next);
  persistStore();
  return next;
}

function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

function sendAsset(route, res) {
  res.sendFile(PUBLIC_ASSETS[route], (err) => {
    if (err) res.status(500).json({ ok: false, error: 'asset_unavailable' });
  });
}

function tokensMatch(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function requireGameToken(req, res, next) {
  if (!config.gameToken) return next();
  const provided = req.get('x-game-token') || (req.body && req.body.gameToken) || '';
  if (!tokensMatch(provided, config.gameToken)) {
    return res.status(401).json({ ok: false, error: 'invalid_game_token' });
  }
  return next();
}

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || 'unknown';
  const entry = hits.get(key);
  if (!entry || now >= entry.resetAt) {
    hits.set(key, { count: 1, resetAt: now + config.rateLimit.windowMs });
    return next();
  }
  entry.count += 1;
  if (entry.count > config.rateLimit.max) {
    res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
    return res.status(429).json({ ok: false, error: 'rate_limited' });
  }
  return next();
}

const app = express();

app.disable('x-powered-by');
app.use(
  cors({
    origin: config.corsOrigins.includes('*') ? true : config.corsOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Game-Token']
  })
);
app.use(bodyParser.json({ limit: '32kb' }));
app.use(bodyParser.urlencoded({ extended: false, limit: '32kb' }));
app.use(rateLimit);

app.get('/', (req, res) => sendAsset('/', res));
app.get('/index.html', (req, res) => sendAsset('/', res));
app.get('/ads.js', (req, res) => sendAsset('/ads.js', res));

app.get('/health', (req, res) => {
  const all = Array.from(records.values());
  res.json({
    ok: true,
    name: 'exter-minatos',
    version: '2.0.0',
    store: config.storeFile,
    uptimeSeconds: Math.round(process.uptime()),
    active: all.filter((r) => r.state === STATES.ACTIVE).length,
    pending: all.filter((r) => r.state === STATES.PENDING).length
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    ok: true,
    serverLoginUrl: config.serverLoginUrl,
    resetGuest: config.resetGuest,
    releaseUrl: config.releaseUrl,
    sessionTtlMs: config.sessionTtlMs,
    store: config.storeFile,
    uidMinLength: config.uidMinLength,
    uidMaxLength: config.uidMaxLength,
    gameTokenRequired: Boolean(config.gameToken)
  });
});

app.post('/api/steps/validate', (req, res) => {
  const uid = validateUid((req.body || {}).uid);
  if (!uid) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_uid',
      hint:
        'UID must be ' +
        config.uidMinLength +
        '-' +
        config.uidMaxLength +
        ' digits, numbers only'
    });
  }

  pruneExpired();
  const existing = records.get(uid);

  return res.json({
    ok: true,
    step: 'validate',
    uid: uid,
    known: Boolean(existing),
    previousState: existing ? existing.state : null,
    previousSeenAt: existing ? existing.lastSeenAt : null,
    message: existing
      ? 'UID found in local records, state ' + existing.state
      : 'UID format accepted, no local record yet'
  });
});

app.post('/api/steps/allocate', (req, res) => {
  const body = req.body || {};
  const uid = validateUid(body.uid);
  if (!uid) return res.status(400).json({ ok: false, error: 'invalid_uid' });

  pruneExpired();
  const slot = records.size + 1;
  const record = upsert(uid, {
    state: STATES.PENDING,
    slot: slot,
    clientVersion: body.clientVersion || null,
    deviceId: body.deviceId || null,
    challenge: makeToken()
  });

  return res.json({
    ok: true,
    step: 'allocate',
    uid: uid,
    slot: record.slot,
    server: config.host + ':' + config.port,
    loginUrl: config.serverLoginUrl,
    reservedUntil: new Date(Date.now() + config.sessionTtlMs).toISOString(),
    message: 'Slot ' + record.slot + ' reserved on ' + config.host + ':' + config.port
  });
});

app.post('/api/steps/authorize', (req, res) => {
  const body = req.body || {};
  const uid = validateUid(body.uid);
  if (!uid) return res.status(400).json({ ok: false, error: 'invalid_uid' });

  pruneExpired();
  const existing = records.get(uid);
  if (!existing) {
    return res.status(409).json({
      ok: false,
      error: 'slot_not_allocated',
      hint: 'run POST /api/steps/allocate first'
    });
  }
  if (existing.challenge && body.challenge && body.challenge !== existing.challenge) {
    return res.status(403).json({ ok: false, error: 'challenge_mismatch' });
  }

  const record = upsert(uid, { state: STATES.AUTHORIZED, authorizationToken: makeToken() });

  return res.json({
    ok: true,
    step: 'authorize',
    uid: uid,
    slot: record.slot,
    authorizationToken: record.authorizationToken,
    loginUrl: config.serverLoginUrl,
    resetGuest: config.resetGuest,
    expiresInMs: config.sessionTtlMs,
    message: 'Authorization token issued for slot ' + record.slot
  });
});

app.post('/api/verify', (req, res) => {
  const body = req.body || {};
  const uid = validateUid(body.uid);
  if (!uid) {
    return res.status(400).json({
      ok: false,
      error: 'invalid_uid',
      hint:
        'UID must be ' +
        config.uidMinLength +
        '-' +
        config.uidMaxLength +
        ' digits, numbers only'
    });
  }

  pruneExpired();
  const trace = [];
  const traceStep = (name, detail) => {
    trace.push({ step: name, at: new Date().toISOString(), detail: detail });
  };

  const existing = records.get(uid);
  traceStep(
    'validate',
    existing ? 'UID found in local records, state ' + existing.state : 'UID format accepted, no local record yet'
  );

  const slot = existing && existing.slot ? existing.slot : records.size + 1;
  const allocated = upsert(uid, {
    state: STATES.PENDING,
    slot: slot,
    clientVersion: body.clientVersion || (existing ? existing.clientVersion : null),
    deviceId: body.deviceId || (existing ? existing.deviceId : null),
    challenge: makeToken()
  });
  traceStep('allocate', 'Slot ' + allocated.slot + ' reserved on ' + config.host + ':' + config.port);

  const authorized = upsert(uid, { state: STATES.AUTHORIZED, authorizationToken: makeToken() });
  traceStep('authorize', 'Authorization token issued for slot ' + authorized.slot);

  const stamp = new Date().toISOString();
  const active = upsert(uid, {
    state: STATES.ACTIVE,
    authorizedAt: authorized.authorizedAt || stamp,
    activatedAt: authorized.activatedAt || stamp,
    activationToken: makeToken(),
    note: body.note || authorized.note
  });
  traceStep('complete', 'UID stored as active in ' + config.storeFile);

  return res.json({
    ok: true,
    step: 'complete',
    activated: true,
    uid: active.uid,
    state: active.state,
    slot: active.slot,
    activationToken: active.activationToken,
    loginUrl: config.serverLoginUrl,
    resetGuest: config.resetGuest,
    expiresAt: publicRecord(active).expiresAt,
    steps: trace,
    record: publicRecord(active)
  });
});

app.post('/api/activate', (req, res) => {
  const body = req.body || {};
  const uid = validateUid(body.uid);
  if (!uid) return res.status(400).json({ ok: false, error: 'invalid_uid' });

  pruneExpired();
  const existing = records.get(uid);
  const activationToken = makeToken();
  const record = upsert(uid, {
    state: STATES.ACTIVE,
    slot: existing ? existing.slot : records.size + 1,
    authorizedAt: existing ? existing.authorizedAt || new Date().toISOString() : new Date().toISOString(),
    activatedAt: existing ? existing.activatedAt || new Date().toISOString() : new Date().toISOString(),
    activationToken: activationToken,
    note: body.note || (existing ? existing.note : '')
  });

  return res.json({
    ok: true,
    step: 'complete',
    activated: true,
    uid: record.uid,
    state: record.state,
    slot: record.slot,
    activationToken: record.activationToken,
    loginUrl: config.serverLoginUrl,
    resetGuest: config.resetGuest,
    expiresAt: publicRecord(record).expiresAt,
    record: publicRecord(record)
  });
});

app.get('/api/activation/:uid', requireGameToken, (req, res) => {
  const uid = validateUid(req.params.uid);
  if (!uid) return res.status(400).json({ ok: false, error: 'invalid_uid' });

  pruneExpired();
  const record = records.get(uid);
  const activated = Boolean(record && record.state === STATES.ACTIVE && !isExpired(record));

  if (activated) record.lastSeenAt = new Date().toISOString();

  return res.json({
    ok: true,
    uid: uid,
    activated: activated,
    state: record ? record.state : 'unknown',
    activationToken: activated ? record.activationToken : null,
    loginUrl: config.serverLoginUrl,
    resetGuest: config.resetGuest,
    expiresAt: activated ? publicRecord(record).expiresAt : null,
    record: record && !isExpired(record) ? publicRecord(record) : null
  });
});

app.get('/api/sessions', (req, res) => {
  pruneExpired();
  const list = Array.from(records.values())
    .map(publicRecord)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ ok: true, count: list.length, store: config.storeFile, records: list });
});

app.get('/api/sessions/pending', (req, res) => {
  pruneExpired();
  const list = Array.from(records.values())
    .filter((r) => r.state === STATES.PENDING || r.state === STATES.AUTHORIZED)
    .map(publicRecord)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ ok: true, count: list.length, records: list });
});

app.post('/api/deactivate', (req, res) => {
  const uid = validateUid((req.body || {}).uid);
  if (!uid) return res.status(400).json({ ok: false, error: 'invalid_uid' });
  if (!records.has(uid)) return res.status(404).json({ ok: false, error: 'uid_not_found' });
  const record = upsert(uid, { state: STATES.REVOKED, activationToken: null });
  return res.json({ ok: true, uid: uid, state: record.state });
});

app.post('/api/guest/reset', requireGameToken, (req, res) => {
  if (!config.resetGuest) {
    return res.status(403).json({ ok: false, error: 'guest_reset_disabled' });
  }
  const scope = (req.body || {}).uid;
  let removed = 0;
  if (scope) {
    const uid = validateUid(scope);
    if (!uid) return res.status(400).json({ ok: false, error: 'invalid_uid' });
    if (records.delete(uid)) removed = 1;
  } else {
    for (const [uid, record] of records) {
      if (record.state !== STATES.ACTIVE) {
        records.delete(uid);
        removed += 1;
      }
    }
  }
  persistStore();
  return res.json({ ok: true, reset: removed, resetGuest: config.resetGuest });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ ok: false, error: err.code || 'internal_error' });
});

function start() {
  loadStore();
  if (config.resetGuest && config.resetGuestOnLaunch) {
    for (const [uid, record] of records) {
      if (record.state !== STATES.ACTIVE) records.delete(uid);
    }
    persistStore();
  }
  pruneExpired();

  const server = app.listen(config.port, config.host, () => {
    console.log('exter minatos :: online');
    console.log('  web        http://' + config.host + ':' + config.port + '/');
    console.log('  login url  ' + config.serverLoginUrl);
    console.log('  store      ' + STORE_PATH);
    console.log('  uid range  ' + config.uidMinLength + '-' + config.uidMaxLength + ' digits');
    console.log('  guest rst  ' + (config.resetGuest ? 'enabled' : 'disabled'));
    console.log('  game token ' + (config.gameToken ? 'required' : 'open'));
  });

  const sweeper = setInterval(() => {
    const removed = pruneExpired();
    if (removed > 0) persistStore();
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (now >= entry.resetAt) hits.delete(key);
    }
  }, 30000);
  sweeper.unref();

  const shutdown = () => {
    persistStore();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) start();

module.exports = app;
