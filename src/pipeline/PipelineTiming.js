/**
 * Lightweight stage timer for landing + engineer pipeline debugging.
 * Exposes timings on globalThis.__vipStageTimings (read by debug scripts).
 */
'use strict';

const _stages = new Map();

function flush() {
  const out = Object.create(null);
  const now = performance.now();
  for (const [name, rec] of _stages) {
    out[name] = rec.end != null ? rec.ms : Math.round(now - rec.start);
  }
  globalThis.__vipStageTimings = out;
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('vip_debug') === '1') {
      console.log('[VIP][timing]', out);
    }
  } catch (_) { /* ignore */ }
}

export function resetTimings() {
  _stages.clear();
  globalThis.__vipStageTimings = Object.create(null);
}

export function stageStart(name) {
  _stages.set(name, { start: performance.now(), end: null, ms: null });
  flush();
}

export function stageEnd(name) {
  const rec = _stages.get(name);
  if (!rec || rec.end != null) return;
  rec.end = performance.now();
  rec.ms = Math.round(rec.end - rec.start);
  flush();
}

export function getTimings() {
  flush();
  return { ...globalThis.__vipStageTimings };
}