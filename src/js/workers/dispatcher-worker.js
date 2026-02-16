/**
 * VoiceIsolate Pro v9.0 — Dispatcher Worker
 * "Threads from Space" Concurrency Architecture
 *
 * Central orchestrator that manages a pool of DSP workers,
 * implements priority-queue scheduling, and routes jobs.
 *
 * Message protocol (inbound):
 *   { type: 'init',    payload: { workerUrl, poolSize, sharedBuffer } }
 *   { type: 'process', payload: { id, audio, config, priority } }
 *   { type: 'batch',   payload: { jobs: [{id, audio, config}], priority } }
 *   { type: 'cancel',  payload: { id } }
 *   { type: 'pause',   payload: {} }
 *   { type: 'resume',  payload: {} }
 *   { type: 'status',  payload: {} }
 *
 * Response protocol (outbound):
 *   { type: 'progress', payload: { id, stage, stageCount, percent } }
 *   { type: 'complete', payload: { id, audio, duration } }
 *   { type: 'error',    payload: { id, code, message } }
 *   { type: 'status',   payload: { pool, queue, jobs } }
 */

'use strict';

/* ================================================================
 * Priority Constants
 * ================================================================ */
const PRIORITY = {
  REALTIME: 0,
  CREATOR:  1,
  BATCH:    2
};

/* ================================================================
 * Job States
 * ================================================================ */
const STATE = {
  QUEUED:     'queued',
  PROCESSING: 'processing',
  COMPLETE:   'complete',
  ERROR:      'error',
  CANCELLED:  'cancelled'
};

/* ================================================================
 * Priority Queue — min-heap ordered by (priority, timestamp)
 * ================================================================ */
class PriorityQueue {
  constructor() {
    this._heap = [];
  }

  get size() {
    return this._heap.length;
  }

  enqueue(item) {
    this._heap.push(item);
    this._bubbleUp(this._heap.length - 1);
  }

  dequeue() {
    if (this._heap.length === 0) return null;
    const top = this._heap[0];
    const last = this._heap.pop();
    if (this._heap.length > 0) {
      this._heap[0] = last;
      this._sinkDown(0);
    }
    return top;
  }

  peek() {
    return this._heap.length > 0 ? this._heap[0] : null;
  }

  remove(predicate) {
    const idx = this._heap.findIndex(predicate);
    if (idx === -1) return null;
    const item = this._heap[idx];
    const last = this._heap.pop();
    if (idx < this._heap.length) {
      this._heap[idx] = last;
      this._bubbleUp(idx);
      this._sinkDown(idx);
    }
    return item;
  }

  drain() {
    const items = [];
    while (this._heap.length > 0) {
      items.push(this.dequeue());
    }
    return items;
  }

  toArray() {
    return this._heap.slice().sort((a, b) => this._compare(a, b));
  }

  _compare(a, b) {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.timestamp - b.timestamp;
  }

  _bubbleUp(idx) {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this._compare(this._heap[idx], this._heap[parent]) >= 0) break;
      this._swap(idx, parent);
      idx = parent;
    }
  }

  _sinkDown(idx) {
    const len = this._heap.length;
    while (true) {
      let smallest = idx;
      const left  = 2 * idx + 1;
      const right = 2 * idx + 2;
      if (left < len && this._compare(this._heap[left], this._heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < len && this._compare(this._heap[right], this._heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === idx) break;
      this._swap(idx, smallest);
      idx = smallest;
    }
  }

  _swap(i, j) {
    const tmp = this._heap[i];
    this._heap[i] = this._heap[j];
    this._heap[j] = tmp;
  }
}

/* ================================================================
 * Dispatcher State
 * ================================================================ */

/** @type {Worker[]} */
let workerPool = [];

/** @type {boolean[]} — true if worker at index is idle */
let workerIdle = [];

/** @type {Map<string, object>} — jobId -> job record */
const jobRegistry = new Map();

/** @type {Map<number, string>} — workerIndex -> currently assigned jobId */
const workerAssignments = new Map();

/** @type {PriorityQueue} */
const jobQueue = new PriorityQueue();

/** @type {boolean} */
let paused = false;

/** @type {boolean} */
let initialized = false;

/** @type {boolean} */
let sharedArrayBufferAvailable = false;

/** @type {string|null} */
let dspWorkerUrl = null;

/** @type {number} */
let poolSize = 0;

/** @type {number} — monotonically increasing job counter for tiebreaking */
let jobCounter = 0;

/* ================================================================
 * DSP Worker Blob URL Generation
 * ================================================================ */

/**
 * Build a Blob URL that loads the DSP worker script.
 * If `url` is provided, we create a small bootstrap worker that
 * importScripts the real file. Otherwise the caller must provide
 * inline source (not used in this architecture).
 */
function createDSPWorkerBlobUrl(url) {
  const bootstrap = `
    'use strict';
    try {
      importScripts('${url}');
    } catch (e) {
      self.postMessage({
        type: 'error',
        payload: { code: 'WORKER_LOAD_FAILED', message: e.message }
      });
    }
  `;
  const blob = new Blob([bootstrap], { type: 'application/javascript' });
  return URL.createObjectURL(blob);
}

/* ================================================================
 * Worker Pool Management
 * ================================================================ */

function initPool(url, size) {
  dspWorkerUrl = url;
  poolSize = size;

  // Detect SharedArrayBuffer availability
  try {
    const testBuf = new SharedArrayBuffer(8);
    sharedArrayBufferAvailable = true;
  } catch (_e) {
    sharedArrayBufferAvailable = false;
  }

  for (let i = 0; i < poolSize; i++) {
    spawnWorker(i);
  }

  initialized = true;
}

function spawnWorker(index) {
  let worker;
  try {
    // Try direct URL first — works when served from same origin
    worker = new Worker(dspWorkerUrl);
  } catch (_e) {
    // Fall back to blob URL with importScripts
    try {
      const blobUrl = createDSPWorkerBlobUrl(dspWorkerUrl);
      worker = new Worker(blobUrl);
    } catch (e2) {
      reportError(null, 'POOL_INIT_FAILED',
        'Could not spawn DSP worker ' + index + ': ' + e2.message);
      return;
    }
  }

  worker.onmessage = function (event) {
    handleWorkerMessage(index, event.data);
  };

  worker.onerror = function (event) {
    const jobId = workerAssignments.get(index) || null;
    reportError(jobId, 'WORKER_ERROR', event.message || 'Unknown worker error');

    // Mark worker idle and attempt recovery
    freeWorker(index);

    // If this worker died, try to respawn it
    try {
      workerPool[index].terminate();
    } catch (_e) { /* already dead */ }
    spawnWorker(index);

    scheduleNext();
  };

  workerPool[index] = worker;
  workerIdle[index] = true;
}

function findIdleWorker() {
  for (let i = 0; i < workerPool.length; i++) {
    if (workerIdle[i]) return i;
  }
  return -1;
}

function freeWorker(index) {
  workerIdle[index] = true;
  workerAssignments.delete(index);
}

/* ================================================================
 * Job Lifecycle
 * ================================================================ */

function createJob(id, audio, config, priority, isBatchMember, batchId) {
  const job = {
    id:            id,
    audio:         audio,
    config:        config || {},
    priority:      priority != null ? priority : PRIORITY.CREATOR,
    state:         STATE.QUEUED,
    timestamp:     Date.now(),
    sequence:      jobCounter++,
    startTime:     0,
    isBatchMember: !!isBatchMember,
    batchId:       batchId || null,
    stageCount:    0,
    currentStage:  0
  };
  jobRegistry.set(id, job);
  return job;
}

function enqueueJob(job) {
  jobQueue.enqueue({
    id:        job.id,
    priority:  job.priority,
    timestamp: job.sequence  // use monotonic counter for FIFO within same priority
  });
}

function dispatchJob(workerIndex, job) {
  job.state     = STATE.PROCESSING;
  job.startTime = performance.now();
  workerIdle[workerIndex]  = false;
  workerAssignments.set(workerIndex, job.id);

  const message = {
    type:   'process',
    data:   job.audio,
    config: job.config,
    stages: job.config.stages || null,
    id:     job.id
  };

  // Use transferable objects for zero-copy when possible
  const transfer = [];
  if (job.audio instanceof Float32Array && !sharedArrayBufferAvailable) {
    // Only transfer if it is not backed by SharedArrayBuffer
    if (!(job.audio.buffer instanceof SharedArrayBuffer)) {
      transfer.push(job.audio.buffer);
    }
  }

  try {
    workerPool[workerIndex].postMessage(message, transfer);
  } catch (e) {
    reportError(job.id, 'DISPATCH_FAILED', e.message);
    freeWorker(workerIndex);
    job.state = STATE.ERROR;
  }
}

function scheduleNext() {
  if (paused) return;

  while (jobQueue.size > 0) {
    const idx = findIdleWorker();
    if (idx === -1) break;  // no idle workers

    const entry = jobQueue.dequeue();
    if (!entry) break;

    const job = jobRegistry.get(entry.id);
    if (!job || job.state === STATE.CANCELLED) {
      // Skip cancelled or missing jobs
      continue;
    }

    dispatchJob(idx, job);
  }
}

/* ================================================================
 * Handle messages FROM DSP workers
 * ================================================================ */

function handleWorkerMessage(workerIndex, msg) {
  const jobId = msg.id || workerAssignments.get(workerIndex);
  const job = jobId ? jobRegistry.get(jobId) : null;

  switch (msg.type) {
    case 'progress': {
      if (job) {
        job.currentStage = msg.stage || 0;
        job.stageCount   = msg.stageCount || job.stageCount;
      }
      self.postMessage({
        type: 'progress',
        payload: {
          id:         jobId,
          stage:      msg.stage || 0,
          stageName:  msg.stageName || '',
          stageCount: msg.stageCount || 0,
          percent:    msg.percent || 0
        }
      });
      break;
    }

    case 'complete': {
      const duration = job ? (performance.now() - job.startTime) : 0;
      if (job) {
        job.state = STATE.COMPLETE;
      }

      // Build response
      const response = {
        type: 'complete',
        payload: {
          id:       jobId,
          audio:    msg.data || null,
          duration: Math.round(duration * 100) / 100
        }
      };

      // Transfer audio data back to main thread when possible
      const transfer = [];
      if (msg.data instanceof Float32Array) {
        if (!(msg.data.buffer instanceof SharedArrayBuffer)) {
          transfer.push(msg.data.buffer);
        }
      }

      self.postMessage(response, transfer);

      freeWorker(workerIndex);
      cleanupJob(jobId);
      scheduleNext();
      break;
    }

    case 'error': {
      if (job) {
        job.state = STATE.ERROR;
      }
      reportError(jobId, msg.code || 'DSP_ERROR', msg.message || 'Unknown DSP error');
      freeWorker(workerIndex);
      cleanupJob(jobId);
      scheduleNext();
      break;
    }

    default:
      break;
  }
}

/**
 * Remove completed/errored/cancelled jobs from registry after a delay
 * to allow status queries to see them briefly.
 */
function cleanupJob(jobId) {
  setTimeout(function () {
    const job = jobRegistry.get(jobId);
    if (job && (job.state === STATE.COMPLETE ||
                job.state === STATE.ERROR ||
                job.state === STATE.CANCELLED)) {
      jobRegistry.delete(jobId);
    }
  }, 30000); // 30s retention
}

/* ================================================================
 * Batch Processing
 * ================================================================ */

let batchCounter = 0;

function processBatch(jobs, priority) {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    reportError(null, 'INVALID_BATCH', 'Batch must contain at least one job');
    return;
  }

  const batchId = 'batch_' + (batchCounter++);
  const batchPriority = priority != null ? priority : PRIORITY.BATCH;

  for (let i = 0; i < jobs.length; i++) {
    const spec = jobs[i];
    const id = spec.id || (batchId + '_' + i);
    const job = createJob(id, spec.audio, spec.config, batchPriority, true, batchId);
    enqueueJob(job);
  }

  // Notify main thread that batch was accepted
  self.postMessage({
    type: 'status',
    payload: {
      event:    'batch_accepted',
      batchId:  batchId,
      jobCount: jobs.length
    }
  });

  scheduleNext();
}

/* ================================================================
 * Cancel / Pause / Resume
 * ================================================================ */

function cancelJob(jobId) {
  const job = jobRegistry.get(jobId);
  if (!job) {
    reportError(jobId, 'NOT_FOUND', 'Job not found: ' + jobId);
    return;
  }

  if (job.state === STATE.QUEUED) {
    job.state = STATE.CANCELLED;
    jobQueue.remove(function (entry) { return entry.id === jobId; });
    self.postMessage({
      type: 'complete',
      payload: { id: jobId, cancelled: true }
    });
  } else if (job.state === STATE.PROCESSING) {
    // Find which worker is running this job and terminate/respawn
    for (const [wIdx, jId] of workerAssignments.entries()) {
      if (jId === jobId) {
        job.state = STATE.CANCELLED;
        try {
          workerPool[wIdx].terminate();
        } catch (_e) { /* best effort */ }
        spawnWorker(wIdx);
        freeWorker(wIdx);
        self.postMessage({
          type: 'complete',
          payload: { id: jobId, cancelled: true }
        });
        scheduleNext();
        break;
      }
    }
  }
}

function cancelBatch(batchId) {
  for (const [jobId, job] of jobRegistry.entries()) {
    if (job.batchId === batchId) {
      cancelJob(jobId);
    }
  }
}

function pauseQueue() {
  paused = true;
  self.postMessage({
    type: 'status',
    payload: { event: 'paused' }
  });
}

function resumeQueue() {
  paused = false;
  self.postMessage({
    type: 'status',
    payload: { event: 'resumed' }
  });
  scheduleNext();
}

/* ================================================================
 * Status Reporting
 * ================================================================ */

function reportStatus() {
  const poolStatus = workerPool.map(function (_w, i) {
    return {
      index:  i,
      idle:   workerIdle[i],
      jobId:  workerAssignments.get(i) || null
    };
  });

  const queueSnapshot = jobQueue.toArray().map(function (entry) {
    const job = jobRegistry.get(entry.id);
    return {
      id:       entry.id,
      priority: entry.priority,
      state:    job ? job.state : 'unknown'
    };
  });

  const activeJobs = [];
  for (const [id, job] of jobRegistry.entries()) {
    if (job.state === STATE.PROCESSING) {
      activeJobs.push({
        id:           id,
        priority:     job.priority,
        currentStage: job.currentStage,
        stageCount:   job.stageCount,
        elapsed:      Math.round(performance.now() - job.startTime)
      });
    }
  }

  self.postMessage({
    type: 'status',
    payload: {
      initialized:  initialized,
      paused:       paused,
      poolSize:     poolSize,
      pool:         poolStatus,
      queueDepth:   jobQueue.size,
      queue:        queueSnapshot,
      activeJobs:   activeJobs,
      totalTracked: jobRegistry.size,
      sharedArrayBufferAvailable: sharedArrayBufferAvailable
    }
  });
}

/* ================================================================
 * Error Reporting Helper
 * ================================================================ */

function reportError(jobId, code, message) {
  self.postMessage({
    type: 'error',
    payload: {
      id:      jobId,
      code:    code,
      message: message
    }
  });
}

/* ================================================================
 * Generate Unique Job ID
 * ================================================================ */

let idCounter = 0;

function generateJobId() {
  return 'job_' + Date.now().toString(36) + '_' + (idCounter++).toString(36);
}

/* ================================================================
 * Inbound Message Handler
 * ================================================================ */

self.onmessage = function (event) {
  var msg = event.data;
  if (!msg || !msg.type) {
    reportError(null, 'INVALID_MESSAGE', 'Message must have a type field');
    return;
  }

  var payload = msg.payload || {};

  try {
    switch (msg.type) {

      case 'init': {
        if (initialized) {
          reportError(null, 'ALREADY_INITIALIZED', 'Dispatcher already initialized');
          return;
        }

        var workerUrl = payload.workerUrl;
        if (!workerUrl) {
          reportError(null, 'MISSING_WORKER_URL',
            'init payload must include workerUrl');
          return;
        }

        // Default pool size: half of hardware concurrency, min 1, max 16
        var requestedSize = payload.poolSize;
        var hwConcurrency = 4; // safe default inside worker
        try {
          if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
            hwConcurrency = navigator.hardwareConcurrency;
          }
        } catch (_e) { /* navigator may not exist */ }

        var size = requestedSize || Math.max(1, Math.min(16, Math.floor(hwConcurrency / 2)));

        initPool(workerUrl, size);

        self.postMessage({
          type: 'status',
          payload: {
            event:      'initialized',
            poolSize:   poolSize,
            sharedArrayBufferAvailable: sharedArrayBufferAvailable
          }
        });
        break;
      }

      case 'process': {
        if (!initialized) {
          reportError(null, 'NOT_INITIALIZED', 'Call init before process');
          return;
        }

        var id = payload.id || generateJobId();
        var audio = payload.audio;
        if (!audio) {
          reportError(id, 'MISSING_AUDIO', 'process payload must include audio data');
          return;
        }

        var priority = PRIORITY.CREATOR; // default
        if (payload.priority === 'realtime' || payload.priority === 0) {
          priority = PRIORITY.REALTIME;
        } else if (payload.priority === 'creator' || payload.priority === 1) {
          priority = PRIORITY.CREATOR;
        } else if (payload.priority === 'batch' || payload.priority === 2) {
          priority = PRIORITY.BATCH;
        }

        var job = createJob(id, audio, payload.config, priority, false, null);
        enqueueJob(job);
        scheduleNext();
        break;
      }

      case 'batch': {
        if (!initialized) {
          reportError(null, 'NOT_INITIALIZED', 'Call init before batch');
          return;
        }

        var batchPriority = PRIORITY.BATCH;
        if (payload.priority === 'creator' || payload.priority === 1) {
          batchPriority = PRIORITY.CREATOR;
        } else if (payload.priority === 'realtime' || payload.priority === 0) {
          batchPriority = PRIORITY.REALTIME;
        }

        processBatch(payload.jobs, batchPriority);
        break;
      }

      case 'cancel': {
        if (payload.batchId) {
          cancelBatch(payload.batchId);
        } else if (payload.id) {
          cancelJob(payload.id);
        } else {
          reportError(null, 'MISSING_ID', 'cancel payload must include id or batchId');
        }
        break;
      }

      case 'pause': {
        pauseQueue();
        break;
      }

      case 'resume': {
        resumeQueue();
        break;
      }

      case 'status': {
        reportStatus();
        break;
      }

      default: {
        reportError(null, 'UNKNOWN_TYPE', 'Unknown message type: ' + msg.type);
        break;
      }
    }
  } catch (e) {
    reportError(payload.id || null, 'DISPATCHER_EXCEPTION', e.message || String(e));
  }
};

// Signal that dispatcher worker is ready
self.postMessage({
  type: 'status',
  payload: { event: 'ready' }
});
