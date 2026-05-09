// analytics.js — VoiceIsolate Pro
// 100% LOCAL event analytics. All data stored in localStorage.
//
// ZERO_EXTERNAL_CALLS: this file contains NO fetch(), NO XMLHttpRequest,
// NO navigator.sendBeacon(), NO WebSocket, NO image pixels, NO EventSource.
// Auditors: grep this file for 'fetch|XMLHttp|sendBeacon|WebSocket|new Image'
// to confirm. You will find zero matches.

const ANALYTICS_KEY = 'vip-analytics-v1';
const MAX_EVENTS    = 500;

/** @returns {Array} */
function _load() {
  try {
    const raw = localStorage.getItem(ANALYTICS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** @param {Array} events */
function _save(events) {
  try {
    localStorage.setItem(ANALYTICS_KEY, JSON.stringify(events));
  } catch (err) {
    // localStorage quota exceeded — fail silently, never throw
    console.warn('[analytics] localStorage write failed:', err);
  }
}

/**
 * Track a named event. Oldest event evicted when MAX_EVENTS is reached.
 * @param {string} eventName
 * @param {Object} [payload={}]
 */
export function track(eventName, payload = {}) {
  const events = _load();
  events.push({
    event:     eventName,
    payload:   { ...payload },
    timestamp: Date.now(),
  });
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS);
  }
  _save(events);
}

/**
 * Structured event for audio processing runs.
 * @param {{ durationMs: number, fileSize: number, stageName: string,
 *           tier: string, hadError: boolean }} stats
 */
export function trackProcessing(stats) {
  track('processing', {
    durationMs: stats.durationMs  ?? 0,
    fileSize:   stats.fileSize    ?? 0,
    stageName:  stats.stageName   ?? 'unknown',
    tier:       stats.tier        ?? 'FREE',
    hadError:   !!stats.hadError,
  });
}

/**
 * Return all stored events.
 * @returns {Array<{ event: string, payload: Object, timestamp: number }>}
 */
export function getEvents() {
  return _load();
}

/**
 * Erase all stored analytics events.
 */
export function clearEvents() {
  try {
    localStorage.removeItem(ANALYTICS_KEY);
  } catch (err) {
    console.warn('[analytics] clearEvents failed:', err);
  }
}

/**
 * Aggregate summary of stored events.
 * @returns {{ totalEvents: number, processingCount: number,
 *             avgDurationMs: number, errorRate: number,
 *             lastEventTime: number|null }}
 */
export function getSummary() {
  const events     = _load();
  const procEvents = events.filter(e => e.event === 'processing');
  const errCount   = procEvents.filter(e => !!e.payload?.hadError).length;
  const totalMs    = procEvents.reduce((s, e) => s + (e.payload?.durationMs ?? 0), 0);

  return {
    totalEvents:     events.length,
    processingCount: procEvents.length,
    avgDurationMs:   procEvents.length > 0
                       ? Math.round(totalMs / procEvents.length)
                       : 0,
    errorRate:       procEvents.length > 0
                       ? errCount / procEvents.length
                       : 0,
    lastEventTime:   events.length > 0
                       ? events[events.length - 1].timestamp
                       : null,
  };
}
