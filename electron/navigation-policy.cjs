'use strict';

/**
 * Pure navigation / IPC trust policy for the Electron main process.
 *
 * The preload exposes `window.vipDesktop` to whatever document a window holds,
 * so the trust boundary is the document's origin: only the packaged app
 * (vip://app) or, in development, the configured dev-server origin may drive
 * IPC or stay loaded in the main window. Everything else is either opened in
 * the system browser (http/https/mailto only) or refused.
 *
 * Kept free of `electron` imports so it is unit-testable in Node.
 */

const path = require('path');

const EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

function parse(url) {
  try { return new URL(String(url)); } catch { return null; }
}

/**
 * @param {string} url
 * @param {{ isDev?: boolean, devUrl?: string }} [opts]
 * @returns {boolean} true when `url` is the app's own document origin.
 */
function isAppUrl(url, { isDev = false, devUrl = '' } = {}) {
  const u = parse(url);
  if (!u) return false;
  if (u.protocol === 'vip:' && u.host === 'app') return true;
  if (isDev) {
    const dev = parse(devUrl);
    return Boolean(dev) && u.origin === dev.origin;
  }
  return false;
}

/**
 * `shell.openExternal` hands a URL to the OS; a `file:` or registered custom
 * scheme there can launch local programs. Only web and mail links qualify.
 */
function isSafeExternalUrl(url) {
  const u = parse(url);
  return Boolean(u) && EXTERNAL_PROTOCOLS.has(u.protocol);
}

/** Google / Firebase sign-in popups used by the optional Drive file I/O (ADR-002). */
function isAllowedAuthPopup(url) {
  const u = parse(url);
  if (!u || u.protocol !== 'https:') return false;
  const host = u.hostname;
  return host === 'accounts.google.com'
    || host === 'apis.google.com'
    || host.endsWith('.google.com')
    || host.endsWith('.googleusercontent.com')
    || host.endsWith('.firebaseapp.com')
    || host === 'www.gstatic.com';
}

/**
 * Resolve a renderer-supplied model-cache path inside `dir`, or null.
 * Rejects non-strings, absolute paths, drive letters and any escape from `dir`.
 */
function resolveInside(dir, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0')) return null;
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) return null;
  const root = path.resolve(dir);
  const full = path.resolve(root, relativePath);
  return full.startsWith(root + path.sep) ? full : null;
}

module.exports = { isAppUrl, isSafeExternalUrl, isAllowedAuthPopup, resolveInside };
