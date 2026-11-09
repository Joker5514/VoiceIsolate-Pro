/**
 * In-memory Google Drive access token.
 * Not stored on window. Processing never reads this module.
 */
'use strict';

/** @type {string|null} */
let _token = null;
/** @type {Set<(token: string|null) => void>} */
const _listeners = new Set();

function dropWindowToken() {
  if (typeof globalThis === 'undefined') return;
  if (!Object.prototype.hasOwnProperty.call(globalThis, '__vipGoogleDriveAccessToken')) return;
  try { delete globalThis.__vipGoogleDriveAccessToken; } catch { /* non-configurable */ }
}

export function getDriveAccessToken() {
  return _token;
}

export function setDriveAccessToken(token) {
  _token = token ? String(token) : null;
  dropWindowToken();
  for (const listener of _listeners) {
    try { listener(_token); } catch { /* subscriber errors must not leak the token */ }
  }
  return _token;
}

export function onDriveAccessToken(listener) {
  _listeners.add(listener);
  try { listener(_token); } catch { /* ignore */ }
  return () => { _listeners.delete(listener); };
}
