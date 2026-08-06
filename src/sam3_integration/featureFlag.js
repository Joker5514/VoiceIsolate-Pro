/**
 * SAM 3 vision sidecar feature flags.
 * Default OFF — opt-in only. Never enables cloud or audio-path injection.
 */
'use strict';

/** @type {readonly string[]} */
export const SAM3_ENV_KEYS = Object.freeze([
  'VIP_SAM3_ENABLED',
  'SAM3_ENABLED',
]);

/**
 * @param {Record<string, string|undefined>|null|undefined} [env]
 * @param {object} [opts]
 * @param {boolean} [opts.queryParam] — if true, also check ?sam3=1 in browser
 * @returns {boolean}
 */
export function isSam3Enabled(env = null, opts = {}) {
  const e = env
    || (typeof process !== 'undefined' ? process.env : null)
    || {};
  for (const k of SAM3_ENV_KEYS) {
    const v = String(e[k] || '').toLowerCase();
    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  }
  if (opts.queryParam && typeof globalThis !== 'undefined' && globalThis.location?.search) {
    try {
      const q = new URLSearchParams(globalThis.location.search);
      const v = String(q.get('sam3') || '').toLowerCase();
      if (v === '1' || v === 'true' || v === 'on') return true;
    } catch { /* ignore */ }
  }
  // localStorage opt-in (dev / power users)
  try {
    if (typeof localStorage !== 'undefined') {
      const v = String(localStorage.getItem('vip-sam3-enabled') || '').toLowerCase();
      if (v === '1' || v === 'true') return true;
    }
  } catch { /* ignore */ }
  return false;
}

/** SAM 3.1 Object Multiplex adapter — off until Meta sources verified. */
export function isSam31MultiplexEnabled(env = null) {
  const e = env
    || (typeof process !== 'undefined' ? process.env : null)
    || {};
  const v = String(e.VIP_SAM3_1_MULTIPLEX || e.SAM3_1_MULTIPLEX || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export default { isSam3Enabled, isSam31MultiplexEnabled, SAM3_ENV_KEYS };
