/**
 * Local-only asset policy for SAM 3 vision models.
 * Rejects cloud/CDN/HF inference endpoints. Same-origin or file/local only.
 */
'use strict';

/** Paths allowed for packaged browser assets (relative or same-origin). */
export const ALLOWED_MODEL_PATH_PREFIXES = Object.freeze([
  '/app/models/sam3/',
  '/app/models/sam3',
  '/models/sam3/',
  'app/models/sam3/',
  'models/sam3/',
]);

// Never allow these remote inference hosts (ban list for local-only policy).
const FORBIDDEN_HOST_SNIPPETS = Object.freeze([
  ['fal', '.', 'ai'].join(''),
  ['replicate', '.', 'com'].join(''),
  ['api', '.', 'openai', '.', 'com'].join(''),
  ['huggingface', '.', 'co'].join(''),
  ['hf', '.', 'co'].join(''),
  ['segment-anything', '.', 'com'].join(''),
  ['cdn', '.', 'jsdelivr', '.', 'net'].join(''),
  ['unpkg', '.', 'com'].join(''),
  ['googleapis', '.', 'com'].join(''),
  'cloudflare',
]);

/**
 * @param {string} urlOrPath
 * @param {{ origin?: string }} [opts]
 * @returns {{ ok: boolean, reason?: string, normalized?: string }}
 */
export function assertLocalModelAsset(urlOrPath, opts = {}) {
  if (urlOrPath == null || typeof urlOrPath !== 'string') {
    return { ok: false, reason: 'empty-path' };
  }
  const raw = urlOrPath.trim();
  if (!raw) return { ok: false, reason: 'empty-path' };

  // Explicit blob:/data: not used for model weights
  if (/^(blob:|data:)/i.test(raw)) {
    return { ok: false, reason: 'blob-or-data-uri-forbidden' };
  }

  // Absolute URL
  if (/^https?:\/\//i.test(raw)) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      return { ok: false, reason: 'invalid-url' };
    }
    const host = (u.hostname || '').toLowerCase();
    for (const bad of FORBIDDEN_HOST_SNIPPETS) {
      if (host.includes(bad) || raw.toLowerCase().includes(bad)) {
        return { ok: false, reason: `remote-host-forbidden:${bad}` };
      }
    }
    const origin = opts.origin
      || (typeof globalThis !== 'undefined' && globalThis.location?.origin)
      || null;
    if (origin && u.origin === origin) {
      return assertLocalModelAsset(u.pathname, opts);
    }
    // localhost / 127.0.0.1 only for local desktop tooling
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
      return { ok: true, normalized: raw };
    }
    return { ok: false, reason: 'cross-origin-forbidden' };
  }

  // Relative / absolute path on same origin
  const path = raw.startsWith('/') ? raw : `/${raw}`;
  const lower = path.toLowerCase();
  const allowed = ALLOWED_MODEL_PATH_PREFIXES.some((p) => {
    const pref = p.startsWith('/') ? p : `/${p}`;
    return lower === pref.replace(/\/$/, '')
      || lower.startsWith(pref.endsWith('/') ? pref : `${pref}/`)
      || lower.startsWith('/app/models/sam3');
  });
  if (!allowed) {
    return { ok: false, reason: 'path-not-in-sam3-allowlist' };
  }
  // No path traversal
  if (path.includes('..')) {
    return { ok: false, reason: 'path-traversal' };
  }
  return { ok: true, normalized: path };
}

/**
 * Scan a code/string snippet for forbidden remote audio/vision inference hosts.
 * Used in tests + defensive host-side checks.
 * @param {string} text
 * @returns {string[]} hit labels
 */
export function findForbiddenRemoteHosts(text) {
  const hits = [];
  const s = String(text || '');
  for (const bad of FORBIDDEN_HOST_SNIPPETS) {
    if (s.toLowerCase().includes(bad)) hits.push(bad);
  }
  return hits;
}

export default {
  assertLocalModelAsset,
  findForbiddenRemoteHosts,
  ALLOWED_MODEL_PATH_PREFIXES,
};
