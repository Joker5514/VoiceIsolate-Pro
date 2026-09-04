/**
 * VoiceIsolate Pro — cooperative job controller (local only, no telemetry).
 *
 * One active user-visible job at a time. Provides AbortSignal + jobId so
 * orchestrators / workers can stop and so only the current job may update UI.
 */
'use strict';

/** @typedef {'running'|'cancelled'|'completed'|'error'} JobStatus */

/**
 * @typedef {object} JobRecord
 * @property {string} id
 * @property {string} title
 * @property {string} [stage]
 * @property {number} [percent]
 * @property {JobStatus} status
 * @property {AbortController} controller
 * @property {number} startedAt
 * @property {number} [endedAt]
 * @property {string} [cancelReason]
 * @property {object} [meta]
 */

/** @type {JobRecord|null} */
let _current = null;
let _seq = 0;
/** @type {Set<(ev: object) => void>} */
const _listeners = new Set();

export class CancellationError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancellationError';
    this.code = 'CANCELLED';
  }
}

export function isCancellationError(err) {
  if (!err) return false;
  if (err instanceof CancellationError) return true;
  if (err.name === 'AbortError' || err.name === 'CancellationError') return true;
  if (err.code === 'CANCELLED' || err.code === 'ABORT_ERR') return true;
  const msg = String(err.message || err);
  return /cancell?ed|aborted/i.test(msg);
}

function emit(type, detail) {
  const ev = { type, ...detail, job: _current };
  for (const fn of _listeners) {
    try { fn(ev); } catch { /* ignore listener errors */ }
  }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(`vip:job:${type}`, { detail: ev }));
    }
  } catch { /* non-DOM */ }
}

/**
 * @param {string} title
 * @param {object} [meta]
 * @returns {JobRecord}
 */
export function beginJob(title, meta = {}) {
  // Starting a new job cancels any previous one (stale-result prevention).
  if (_current && _current.status === 'running') {
    cancelCurrent('superseded');
  }
  const id = `job-${Date.now().toString(36)}-${++_seq}`;
  const controller = typeof AbortController !== 'undefined'
    ? new AbortController()
    : { signal: { aborted: false }, abort() { this.signal.aborted = true; } };
  _current = {
    id,
    title: title || 'Processing…',
    stage: meta.stage || title || 'Working…',
    percent: 0,
    status: 'running',
    controller,
    startedAt: (typeof performance !== 'undefined' ? performance.now() : Date.now()),
    meta,
  };
  emit('start', { jobId: id, title: _current.title });
  return _current;
}

/** @returns {JobRecord|null} */
export function getCurrentJob() {
  return _current;
}

/** @returns {string|null} */
export function getCurrentJobId() {
  return _current?.status === 'running' ? _current.id : null;
}

/** @returns {AbortSignal|null} */
export function getCurrentSignal() {
  return _current?.status === 'running' ? _current.controller.signal : null;
}

/**
 * Only the active job may update UI progress.
 * @param {string} jobId
 * @param {string} [stage]
 * @param {number} [percent]
 */
export function updateJob(jobId, stage, percent) {
  if (!_current || _current.id !== jobId || _current.status !== 'running') return false;
  if (stage != null) _current.stage = stage;
  if (Number.isFinite(percent)) {
    const nextPercent = Math.max(0, Math.min(100, Number(percent)));
    _current.percent = Math.max(_current.percent, nextPercent);
  }
  emit('progress', {
    jobId,
    stage: _current.stage,
    percent: _current.percent,
  });
  return true;
}

/**
 * @param {string} jobId
 * @param {'completed'|'error'|'cancelled'} status
 * @param {Error|object} [detail]
 */
export function endJob(jobId, status, detail) {
  if (!_current || _current.id !== jobId) return false;
  _current.status = status;
  _current.endedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const durationMs = _current.endedAt - _current.startedAt;
  emit('end', {
    jobId,
    status,
    durationMs,
    detail: detail || null,
  });
  // Keep brief reference then clear
  const finished = _current;
  _current = null;
  return finished;
}

/**
 * @param {string} [reason]
 * @returns {boolean} true if a running job was aborted
 */
export function cancelCurrent(reason = 'user') {
  if (!_current || _current.status !== 'running') return false;
  const job = _current;
  try {
    job.controller.abort?.(reason);
  } catch { /* ignore */ }
  job.status = 'cancelled';
  job.cancelReason = reason;
  job.endedAt = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  emit('cancel', { jobId: job.id, reason });
  emit('end', {
    jobId: job.id,
    status: 'cancelled',
    durationMs: job.endedAt - job.startedAt,
    detail: { reason },
  });
  _current = null;
  return true;
}

/**
 * Throw if this job's signal is aborted.
 * @param {AbortSignal} [signal]
 * @param {string} [jobId]
 */
export function throwIfAborted(signal, jobId) {
  if (jobId && _current && _current.id !== jobId && _current.status === 'running') {
    // Another job is active — this one is stale
    throw new CancellationError('Stale job superseded');
  }
  if (signal?.aborted) {
    throw new CancellationError('Cancelled');
  }
}

/**
 * @param {(ev: object) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribeJobs(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** Test helper */
export function _resetJobsForTests() {
  _current = null;
  _seq = 0;
  _listeners.clear();
}

// Browser global for classic scripts (processing-overlay.js)
try {
  if (typeof globalThis !== 'undefined') {
    globalThis.__VIP_JOBS__ = {
      beginJob,
      endJob,
      updateJob,
      cancelCurrent,
      getCurrentJob,
      getCurrentJobId,
      getCurrentSignal,
      isCancellationError,
      CancellationError,
      subscribeJobs,
    };
  }
} catch { /* ignore */ }

export default {
  beginJob,
  endJob,
  updateJob,
  cancelCurrent,
  getCurrentJob,
  getCurrentJobId,
  getCurrentSignal,
  throwIfAborted,
  isCancellationError,
  CancellationError,
  subscribeJobs,
};
