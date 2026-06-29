/**
 * Gated debug logging — silent in production unless ?debug=1 or localStorage vip_debug=1.
 */
'use strict';

export function isDebugEnabled() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('vip_debug') === '1') {
      return true;
    }
    if (typeof location !== 'undefined' && /(?:\?|&)debug=1(?:&|$)/.test(location.search)) {
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

export function debugLog(scope, ...args) {
  if (isDebugEnabled()) console.log(`[VIP][${scope}]`, ...args);
}