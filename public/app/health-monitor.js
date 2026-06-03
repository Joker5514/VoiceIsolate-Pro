/**
 * VoiceIsolate Pro — health-monitor.js
 * =====================================
 * Real-time performance and health diagnostics.
 * Exposed at window.voiceIsolateDiagnostics in non-production environments.
 *
 * Tracks:
 *  - Audio pipeline latency
 *  - ML inference latency
 *  - Dropped frames
 *  - Worker queue depth
 *  - Memory pressure (when Performance Memory API available)
 *
 * Usage (DevTools console):
 *   window.voiceIsolateDiagnostics.report()   // print current metrics
 *   window.voiceIsolateDiagnostics.reset()    // clear history
 *   window.voiceIsolateDiagnostics.start()    // begin auto-reporting
 *   window.voiceIsolateDiagnostics.stop()     // stop auto-reporting
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define(factory);
  } else {
    const exports = factory();
    root.HealthMonitor    = exports.HealthMonitor;
    root.healthMonitor    = exports.healthMonitor;
    // Expose on window for DevTools access (non-production only)
    if (typeof root.location !== 'undefined') {
      const isDev = (
        root.location.hostname === 'localhost' ||
        root.location.hostname === '127.0.0.1' ||
        root.location.search.includes('debug=1') ||
        !!root.VIP_DEBUG
      );
      if (isDev) root.voiceIsolateDiagnostics = exports.healthMonitor;
    }
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SAMPLES = 200;

  function rollingAvg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  function rollingMax(arr) {
    if (!arr.length) return 0;
    return Math.max(...arr);
  }

  function rollingMin(arr) {
    if (!arr.length) return 0;
    return Math.min(...arr);
  }

  class HealthMonitor {
    constructor() {
      this._metrics = {
        audioLatency:     [],
        inferenceLatency: [],
        workerLatency:    [],
        droppedFrames:    0,
        overflows:        0,
        workerQueueDepth: 0,
        processingErrors: 0,
        lastUpdateTs:     Date.now(),
      };
      this._reportInterval = null;
      this._active = false;
    }

    /** Record an audio pipeline latency sample (ms). */
    recordAudioLatency(ms) {
      this._push(this._metrics.audioLatency, ms);
    }

    /** Record an ML inference latency sample (ms). */
    recordInferenceLatency(ms) {
      this._push(this._metrics.inferenceLatency, ms);
    }

    /** Record a worker round-trip latency sample (ms). */
    recordWorkerLatency(ms) {
      this._push(this._metrics.workerLatency, ms);
    }

    /** Increment dropped-frame counter. */
    incrementDroppedFrames(n = 1) {
      this._metrics.droppedFrames += n;
    }

    /** Increment ring-buffer overflow counter. */
    incrementOverflows(n = 1) {
      this._metrics.overflows += n;
    }

    /** Update worker queue depth gauge. */
    setWorkerQueueDepth(n) {
      this._metrics.workerQueueDepth = n;
    }

    /** Increment processing error counter. */
    incrementErrors(n = 1) {
      this._metrics.processingErrors += n;
    }

    /**
     * Build a human-readable snapshot of current metrics.
     * @returns {Object}
     */
    snapshot() {
      const al = this._metrics.audioLatency;
      const il = this._metrics.inferenceLatency;
      const wl = this._metrics.workerLatency;
      const mem = this._getMemory();

      return {
        timestamp: new Date().toISOString(),
        audioLatency: {
          avg: rollingAvg(al).toFixed(2) + ' ms',
          max: rollingMax(al).toFixed(2) + ' ms',
          min: rollingMin(al).toFixed(2) + ' ms',
          samples: al.length,
        },
        inferenceLatency: {
          avg: rollingAvg(il).toFixed(2) + ' ms',
          max: rollingMax(il).toFixed(2) + ' ms',
          samples: il.length,
        },
        workerLatency: {
          avg: rollingAvg(wl).toFixed(2) + ' ms',
          max: rollingMax(wl).toFixed(2) + ' ms',
          samples: wl.length,
        },
        droppedFrames:    this._metrics.droppedFrames,
        overflows:        this._metrics.overflows,
        processingErrors: this._metrics.processingErrors,
        workerQueueDepth: this._metrics.workerQueueDepth,
        memory: mem,
      };
    }

    /** Print a formatted report to the console. */
    report() {
      const s = this.snapshot();
      console.group('[VoiceIsolate Diagnostics]');
      console.log('Audio latency:     ', s.audioLatency);
      console.log('Inference latency: ', s.inferenceLatency);
      console.log('Worker latency:    ', s.workerLatency);
      console.log('Dropped frames:    ', s.droppedFrames);
      console.log('Buffer overflows:  ', s.overflows);
      console.log('Processing errors: ', s.processingErrors);
      console.log('Queue depth:       ', s.workerQueueDepth);
      if (s.memory) console.log('Memory:            ', s.memory);
      console.groupEnd();
      return s;
    }

    /** Reset all metrics. */
    reset() {
      this._metrics = {
        audioLatency:     [],
        inferenceLatency: [],
        workerLatency:    [],
        droppedFrames:    0,
        overflows:        0,
        workerQueueDepth: 0,
        processingErrors: 0,
        lastUpdateTs:     Date.now(),
      };
    }

    /** Start auto-reporting every `intervalMs` milliseconds. */
    start(intervalMs = 10000) {
      this.stop();
      this._active = true;
      this._reportInterval = setInterval(() => this.report(), intervalMs);
    }

    /** Stop auto-reporting. */
    stop() {
      if (this._reportInterval !== null) {
        clearInterval(this._reportInterval);
        this._reportInterval = null;
      }
      this._active = false;
    }

    get isActive() { return this._active; }

    _push(arr, value) {
      arr.push(value);
      if (arr.length > MAX_SAMPLES) arr.shift();
    }

    _getMemory() {
      try {
        if (typeof performance !== 'undefined' && performance.memory) {
          const m = performance.memory;
          return {
            usedMB:  (m.usedJSHeapSize / 1048576).toFixed(1) + ' MB',
            totalMB: (m.totalJSHeapSize / 1048576).toFixed(1) + ' MB',
            limitMB: (m.jsHeapSizeLimit / 1048576).toFixed(1) + ' MB',
          };
        }
      } catch (_) {}
      return null;
    }
  }

  const healthMonitor = new HealthMonitor();

  return { HealthMonitor, healthMonitor };
}));
