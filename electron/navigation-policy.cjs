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

/**
 * Firebase auth domain for the optional Drive sign-in. In Electron the main
 * process is the single source: it hands this value to the preload
 * (`vipDesktop.firebaseAuthDomain`), and public/app/firebase-config.js prefers
 * it, so the renderer signs in on exactly the domain this policy allows. The
 * renderer never tells main which domain to trust.
 */
const DEFAULT_AUTH_DOMAIN = 'voiceisolate-pro.firebaseapp.com';
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

function isValidHostname(name) {
  return name.length <= 253
    && HOSTNAME.test(name)
    && name.split('.').every((label) => label.length <= 63);
}

function authDomain() {
  const configured = (process.env.VIP_FIREBASE_AUTH_DOMAIN || '').trim().toLowerCase();
  return isValidHostname(configured) ? configured : DEFAULT_AUTH_DOMAIN;
}

/**
 * A sign-in popup may only open on the app's own Firebase auth handler or
 * Google's account page — not on any Firebase project or user-content host,
 * which anyone can publish to.
 */
function isAllowedAuthPopup(url) {
  const u = parse(url);
  if (!u || u.protocol !== 'https:') return false;
  return u.hostname === authDomain() || u.hostname === 'accounts.google.com';
}

/** Where an already-open sign-in popup may navigate during the OAuth flow. */
function isAllowedAuthNavigation(url) {
  const u = parse(url);
  if (!u || u.protocol !== 'https:') return false;
  const host = u.hostname;
  return host === authDomain() || host === 'google.com' || host.endsWith('.google.com');
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

/**
 * `resolveInside` plus symlink/junction resolution: the canonical path of the
 * target (or, for a file not yet written, of its deepest existing ancestor)
 * must still sit inside the canonical cache directory.
 *
 * @param {typeof import('fs').promises} fsp
 * @returns {Promise<string|null>}
 */
async function resolveInsideReal(fsp, dir, relativePath) {
  const full = resolveInside(dir, relativePath);
  if (!full) return null;
  const realRoot = await fsp.realpath(dir);
  let probe = full;
  for (;;) {
    try {
      const real = await fsp.realpath(probe);
      return real === realRoot || real.startsWith(realRoot + path.sep) ? full : null;
    } catch (err) {
      if (err && err.code !== 'ENOENT') return null;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

module.exports = {
  authDomain, isAppUrl, isSafeExternalUrl, isAllowedAuthPopup, isAllowedAuthNavigation, resolveInside, resolveInsideReal,
};
