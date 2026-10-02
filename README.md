# exter minatos

Local UID verification service with a three-view web interface (dashboard, verify
page, panel) over an Express backend and a JSON record file.

The service is self-contained. It does not contact Garena or any other third
party. Running the four steps records a UID in the local file and issues a token,
and nothing else.

## Interface

| View | Route | Contents |
| --- | --- | --- |
| Dashboard | `#/home` | Status badge, headline, three primary buttons, feature grid |
| Features | `#/features` | Scrolls to the feature grid on the dashboard |
| Verify | `#/verify` | UID field, the four sequential steps, result panel |
| Panel | `#/panel` | Live config values and every record in the store |

Navigation is hash based, so the back button and direct links work.

## Files

```
x mode/
├── localconfig.json   config (login URL, release URL, guest reset, UID rules)
├── server.js          Express backend (step endpoints, /api/verify, store)
├── index.html         three-view interface (black / dark green)
├── ads.js             ad network loader (empty by default)
├── package.json       dependencies
├── README.md          this file
└── data/
    └── sessions.json  activation store, written on every change
```

## Requirements

- Node.js 16 or newer
- npm

```bash
node -v
npm -v
```

## Install

```bash
cd "C:\Users\BLACNOVA\Pictures\x mode"
npm install express body-parser cors
```

`npm install` alone also works, the same packages are in `package.json`.

## Run

```bash
npm start
```

or

```bash
node server.js
```

Then open `http://127.0.0.1:8080/`. The resolved configuration is printed on
startup.

## Configuration (`localconfig.json`)

| Key | Type | Meaning |
| --- | --- | --- |
| `serverLoginUrl` | string | Login endpoint returned to the game and shown in the interface |
| `releaseUrl` | string | Target of the DOWNLOAD APK button. Empty means the button stays inert and says so |
| `resetGuest` | boolean | Allows `POST /api/guest/reset` to clear non-active records |
| `resetGuestOnLaunch` | boolean | Clears non-active records when the server starts |
| `port` | number | HTTP port, default `8080` |
| `host` | string | Bind address, default `127.0.0.1` |
| `gameToken` | string | Shared secret. If non-empty, game-facing routes require `X-Game-Token` |
| `corsOrigins` | array | Allowed origins, `["*"]` allows any |
| `sessionTtlMs` | number | Record lifetime in milliseconds, default 45 minutes (`2700000`) |
| `storeFile` | string | Store path relative to the project, default `data/sessions.json` |
| `uidMinLength` | number | Minimum UID length in digits, default `8` |
| `uidMaxLength` | number | Maximum UID length in digits, default `12` |
| `rateLimit.windowMs` | number | Rate limit window in milliseconds |
| `rateLimit.max` | number | Requests per window per IP |

The file is read once at startup, restart the server after editing it.

## The four steps

Each step is a separate endpoint. The panel calls them in order and only advances
when the previous call returns `ok: true`, so the animation reflects real
round trips. A failed step stops the sequence and no record is left active.

| # | Step | Endpoint | Result |
| --- | --- | --- | --- |
| 1 | UID Validation & Analysis | `POST /api/steps/validate` | UID matches the digit rules, reports whether it already exists |
| 2 | Server Allocation | `POST /api/steps/allocate` | Reserves a slot, creates a `pending` record with a challenge |
| 3 | Final Authorization | `POST /api/steps/authorize` | Moves the record to `authorized`, issues an authorization token |
| 4 | Verification Complete | `POST /api/verify` | Runs the remaining steps, moves the record to `active`, issues the activation token, writes `sessions.json` |

`POST /api/verify` is also usable on its own. It performs the full chain in one
call and returns a `steps` array with a per-step trace, which is the endpoint to
use from a script or a game client. The panel deliberately uses the separate
step endpoints so the four stages are genuinely sequential.

Record states: `pending` -> `authorized` -> `active`, plus `revoked`.

A verified UID stays usable for `sessionTtlMs` (default 45 minutes) from the last
server contact. The panel counts it down live, shows "Valid for h:mm:ss" in the
result card and a banner above the UID field, and at zero clears the session and
asks the user to re-enter the UID.

## API

| Method | Route | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | no | Liveness plus active and pending counters |
| `GET` | `/api/config` | no | Public config shown in the interface |
| `POST` | `/api/steps/validate` | no | Step 1 |
| `POST` | `/api/steps/allocate` | no | Step 2 |
| `POST` | `/api/steps/authorize` | no | Step 3, `409` if no slot was allocated |
| `POST` | `/api/verify` | no | Full chain in one call, writes the record |
| `POST` | `/api/activate` | no | Marks a record active without the trace |
| `GET` | `/api/activation/:uid` | `X-Game-Token` | Game check, returns `activated` and the token |
| `GET` | `/api/sessions` | no | All records |
| `GET` | `/api/sessions/pending` | no | Records waiting on steps 3 or 4 |
| `POST` | `/api/deactivate` | no | Sets a record to `revoked` |
| `POST` | `/api/guest/reset` | `X-Game-Token` | Clears non-active records, needs `resetGuest` |

Request rules: the UID must be `uidMinLength` to `uidMaxLength` digits, body
limit 32 kB, `rateLimit.max` requests per minute per IP.

### One call instead of four

```bash
curl -X POST http://127.0.0.1:8080/api/verify ^
  -H "Content-Type: application/json" ^
  -d "{\"uid\":\"1234567890\",\"clientVersion\":\"1.0.0\"}"
```

```json
{
  "ok": true,
  "step": "complete",
  "activated": true,
  "uid": "1234567890",
  "state": "active",
  "slot": 1,
  "activationToken": "48 hex chars",
  "loginUrl": "https://login.external-server.example/v1/auth/session",
  "resetGuest": true,
  "expiresAt": "2026-10-01T19:57:19.314Z",
  "steps": [
    { "step": "validate",  "at": "...", "detail": "UID format accepted, no local record yet" },
    { "step": "allocate",  "at": "...", "detail": "Slot 1 reserved on 127.0.0.1:8080" },
    { "step": "authorize", "at": "...", "detail": "Authorization token issued for slot 1" },
    { "step": "complete",  "at": "...", "detail": "UID stored as active in data/sessions.json" }
  ],
  "record": { }
}
```

### Game side check

```bash
curl http://127.0.0.1:8080/api/activation/1234567890 -H "X-Game-Token: YOUR_TOKEN"
```

```json
{
  "ok": true,
  "uid": "1234567890",
  "activated": true,
  "state": "active",
  "activationToken": "48 hex chars",
  "loginUrl": "https://login.external-server.example/v1/auth/session",
  "resetGuest": true,
  "expiresAt": "2026-10-01T19:57:19.314Z"
}
```

Treat the response as valid only when `ok` is `true` and `activated` is `true`.

## Store format (`data/sessions.json`)

```json
{
  "version": 1,
  "updatedAt": "2026-10-01T19:42:19.400Z",
  "service": "exter-minatos",
  "serverLoginUrl": "https://login.external-server.example/v1/auth/session",
  "count": 1,
  "records": [
    {
      "uid": "1234567890",
      "state": "active",
      "slot": 1,
      "note": "",
      "clientVersion": "panel-3.0.0",
      "deviceId": null,
      "challenge": "hex",
      "authorizationToken": "hex",
      "activationToken": "hex",
      "createdAt": "2026-10-01T19:42:19.314Z",
      "authorizedAt": "2026-10-01T19:42:19.314Z",
      "activatedAt": "2026-10-01T19:42:19.314Z",
      "lastSeenAt": "2026-10-01T19:42:19.314Z"
    }
  ]
}
```

The store is rewritten on every change and reloaded on startup. Records older
than `sessionTtlMs` are pruned every 30 seconds and on each request.

## Ad slots

| Slot key | Size | Position |
| --- | --- | --- |
| `home-top-728x90` | 728x90 | top of the dashboard, above the hero |
| `verify-mid-336x280` | 336x280 | below the verify card |
| `verify-side-300x250` | 300x250 | verify view sidebar |
| `panel-mid-336x280` | 336x280 | below the panel record list |
| `panel-side-300x250` | 300x250 | panel view sidebar |
| `bottom-970x250` | 970x250 | bottom of every view, above the footer |
| `continue-interstitial-300x250` | 300x250 | ad gate modal shown before the next step after a Continue click |

To activate them, put the ad markup for each slot into `window.AD_CONFIG.slots`
in `ads.js` and set `enabled: true`. Each slot is rendered in a sandboxed iframe,
so ad code stays isolated from the interface. `window.renderAdSlot(name, host, w, h)`
renders any slot into a given container and is what the Continue gate uses.

When ads are enabled, clicking **Continue** opens the gate, plays the
`continue-interstitial-300x250` ad, and unlocks *Proceed* after 3 seconds. When
ads are disabled or the slot is empty, Continue advances immediately.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `EADDRINUSE` | Change `port`, or stop whatever holds 8080 |
| `Cannot find module 'express'` | Run `npm install` in the project folder |
| Interface shows `status: offline` | The API is not reachable on that host and port |
| DOWNLOAD APK does nothing | `releaseUrl` is empty in `localconfig.json` |
| `invalid_uid` | UID must be 8 to 12 digits, numbers only |
| `slot_not_allocated` | Call `POST /api/steps/allocate` before `authorize` |
| `invalid_game_token` | `gameToken` is set, send the same value in `X-Game-Token` |
| `guest_reset_disabled` | Set `resetGuest` to `true` |
| Game check returns `activated: false` | Steps were not completed, the record expired, or the UID differs |
| Config change had no effect | Restart the server |
| Ad slots are empty | Expected until `ads.js` holds real ad code |

## Notes

- The server binds to `127.0.0.1`, so it is only reachable from the same
  machine. Set `host` to `0.0.0.0` to expose it, and set a non-empty `gameToken`
  first, otherwise the game-facing routes are open.
- `localconfig.json`, `server.js` and `package.json` are not reachable over HTTP,
  only `/`, `/index.html` and `/ads.js` are served.
- The interface does not claim any third-party authorization. A completed run
  means one record was written to the local store, nothing more. Use this only
  with software and accounts you are authorised to test.

