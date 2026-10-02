window.AD_CONFIG = {
  enabled: false,
  slots: {
    'home-top-728x90': '',
    'verify-mid-336x280': '',
    'verify-side-300x250': '',
    'panel-mid-336x280': '',
    'panel-side-300x250': '',
    'bottom-970x250': '',
    'continue-interstitial-300x250': ''
  }
};

window.renderAdSlot = function (name, host, width, height) {
  var config = window.AD_CONFIG;
  if (!config || !config.enabled) return false;

  var hostEl = typeof host === 'string' ? document.getElementById(host) : host;
  if (!hostEl) return false;

  var code = config.slots[name];
  if (!code) return false;

  hostEl.innerHTML = '';

  var frame = document.createElement('iframe');
  frame.title = name;
  frame.width = String(width || 300);
  frame.height = String(height || 250);
  frame.style.border = '0';
  frame.style.display = 'block';
  frame.style.margin = '0 auto';
  frame.setAttribute('scrolling', 'no');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups');

  frame.srcdoc = code;
  hostEl.appendChild(frame);
  return true;
};

(function applyAds() {
  if (!window.AD_CONFIG || !window.AD_CONFIG.enabled) return;

  var slots = document.querySelectorAll('[data-ad-slot]');

  Array.prototype.forEach.call(slots, function (slot) {
    window.renderAdSlot(
      slot.getAttribute('data-ad-slot'),
      slot,
      slot.getAttribute('data-ad-width'),
      slot.getAttribute('data-ad-height')
    );
  });
})();