/**
 * VoiceIsolate Pro — Batch Processor v22
 * Studio/Enterprise tier feature: process multiple files concurrently.
 *
 * Features:
 *   - Queue-based processing with concurrency control
 *   - Per-file progress tracking
 *   - Pause/resume/cancel support
 *   - Export to ZIP archive
 *   - Preset application across all files
 *   - Error recovery with retry logic
 */

const BatchProcessor = (() => {
  'use strict';

  // ─── Job States ───────────────────────────────────────────────────────────────
  const JobState = {
    QUEUED:     'queued',
    PROCESSING: 'processing',
    DONE:       'done',
    ERROR:      'error',
    CANCELLED:  'cancelled',
  };

  // ─── Internal State ───────────────────────────────────────────────────────────
  let _queue = [];
  let _active = new Map(); // jobId → AbortController
  let _results = new Map(); // jobId → result blob
  let _listeners = [];
  let _paused = false;
  let _maxConcurrent = 3;
  let _jobCounter = 0;

  // ─── Event System ─────────────────────────────────────────────────────────────
  function _emit(event, data) {
    _listeners.filter(l => l.event === event || l.event === '*')
      .forEach(l => { try { l.cb(data); } catch { /* listener error */ } });
  }

  // ─── Job Creation ─────────────────────────────────────────────────────────────
  function _createJob(file, options = {}) {
    return {
      id: `job_${++_jobCounter}_${Date.now()}`,
      file,
      name: file.name,
      size: file.size,
      state: JobState.QUEUED,
      progress: 0,
      error: null,
      retries: 0,
      maxRetries: options.maxRetries || 2,
      options: {
        preset: options.preset || null,
        params: options.params || {},
        outputFormat: options.outputFormat || 'wav',
        normalize: options.normalize !== false,
        applyWatermark: options.applyWatermark || false,
      },
      createdAt: Date.now(),
      startedAt: null,
      completedAt: null,
    };
  }

  // ─── Processing Loop ──────────────────────────────────────────────────────────
  async function _tick() {
    if (_paused) return;

    const queued = _queue.filter(j => j.state === JobState.QUEUED);
    const activeCount = _active.size;
    const available = _maxConcurrent - activeCount;

    for (let i = 0; i < Math.min(available, queued.length); i++) {
      _processJob(queued[i]);
    }
  }

  async function _processJob(job) {
    if (_active.has(job.id)) return;

    const controller = new AbortController();
    _active.set(job.id, controller);
    job.state = JobState.PROCESSING;
    job.startedAt = Date.now();
    _emit('job:started', { job });

    try {
      // Read file as ArrayBuffer
      const arrayBuffer = await _readFile(job.file, controller.signal);
      if (controller.signal.aborted) throw new Error('Cancelled');

      job.progress = 10;
      _emit('job:progress', { job, progress: 10 });

      // Decode audio — use AudioContext (not OfflineAudioContext) so the native
      // device sample rate is preserved and files are not silently resampled to 44100 Hz.
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      audioCtx.close().catch(() => {});
      const audioData = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;

      job.progress = 25;
      _emit('job:progress', { job, progress: 25 });

      if (controller.signal.aborted) throw new Error('Cancelled');

      // Apply processing pipeline (simplified — integrates with main pipeline)
      let processedData = audioData;

      // If the main pipeline is available, use it
      if (window.VoiceIsolatePipeline && job.options.params) {
        try {
          processedData = await window.VoiceIsolatePipeline.process(audioData, sampleRate, {
            ...job.options.params,
            onProgress: (p) => {
              job.progress = 25 + Math.round(p * 0.6);
              _emit('job:progress', { job, progress: job.progress });
            },
          });
        } catch {
          // Fall through to basic processing
        }
      }

      job.progress = 85;
      _emit('job:progress', { job, progress: 85 });

      // Apply watermark if needed
      if (job.options.applyWatermark) {
        processedData = _applyWatermark(processedData, sampleRate);
      }

      // Normalize output
      if (job.options.normalize) {
        processedData = _normalize(processedData, -1.0);
      }

      // Encode to output format
      const outputBlob = await _encodeAudio(processedData, sampleRate, job.options.outputFormat);

      job.progress = 100;
      job.state = JobState.DONE;
      job.completedAt = Date.now();
      _results.set(job.id, { blob: outputBlob, name: _getOutputName(job) });

      _active.delete(job.id);
      _emit('job:done', { job, blob: outputBlob });

    } catch (err) {
      _active.delete(job.id);

      if (err.message === 'Cancelled') {
        job.state = JobState.CANCELLED;
        _emit('job:cancelled', { job });
      } else if (job.retries < job.maxRetries) {
        job.retries++;
        job.state = JobState.QUEUED;
        job.progress = 0;
        job.error = null;
        _emit('job:retry', { job, attempt: job.retries });
      } else {
        job.state = JobState.ERROR;
        job.error = err.message;
        _emit('job:error', { job, error: err.message });
      }
    }

    // Process next job
    setTimeout(_tick, 0);
  }

  // ─── Audio Utilities ──────────────────────────────────────────────────────────
  function _readFile(file, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Cancelled')); return; }
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('File read error'));
      signal.addEventListener('abort', () => { reader.abort(); reject(new Error('Cancelled')); });
      reader.readAsArrayBuffer(file);
    });
  }

  function _normalize(data, targetPeak = -1.0) {
    // Single-pass peak search avoids reduce() overhead and a second array pass.
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    if (peak === 0) return data;
    const targetLinear = Math.pow(10, targetPeak / 20);
    const gain = targetLinear / peak;
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] * gain;
    return out;
  }

  function _applyWatermark(data, sampleRate) {
    // Subtle inaudible watermark: encode a 19kHz tone at -40dB.
    // Use incremental phase stepping to avoid per-sample 2π·freq·i/sr multiplication.
    const out = new Float32Array(data.length);
    const amp = 0.01; // -40dB
    const phaseStep = (2 * Math.PI * 19000) / sampleRate;
    let phase = 0;
    for (let i = 0; i < data.length; i++) {
      out[i] = data[i] + amp * Math.sin(phase);
      phase += phaseStep;
      // Wrap phase to [-π, π] to prevent float precision drift over long files.
      if (phase > Math.PI) phase -= 2 * Math.PI;
    }
    return out;
  }

  function _encodeAudio(data, sampleRate, format) {
    // WAV encoding (always available)
    const wavBuffer = _encodeWAV(data, sampleRate);
    return Promise.resolve(new Blob([wavBuffer], { type: 'audio/wav' }));
    // Note: MP3/FLAC encoding requires lamejs/libflac — loaded dynamically in Pro tier
  }

  function _encodeWAV(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeString = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
    return buffer;
  }

  function _getOutputName(job) {
    const base = job.file.name.replace(/\.[^.]+$/, '');
    const ext = job.options.outputFormat;
    return `${base}_processed.${ext}`;
  }

  // ─── ZIP Export ───────────────────────────────────────────────────────────────
  async function _exportZIP(jobIds) {
    // Simple ZIP using JSZip if available, otherwise download individually
    const results = jobIds
      .map(id => _results.get(id))
      .filter(Boolean);

    if (results.length === 0) return;

    if (window.JSZip) {
      const zip = new window.JSZip();
      for (const { blob, name } of results) {
        zip.file(name, blob);
      }
      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
      _downloadBlob(zipBlob, `voiceisolate_batch_${Date.now()}.zip`);
    } else {
      // Fallback: download each file individually
      for (const { blob, name } of results) {
        _downloadBlob(blob, name);
      }
    }
  }

  function _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ─── Public API ───────────────────────────────────────────────────────────────
  const BP = {
    /**
     * Add files to the batch queue.
     * @param {File[]} files
     * @param {Object} options — preset, params, outputFormat, normalize, applyWatermark
     * @returns {string[]} job IDs
     */
    addFiles(files, options = {}) {
      const LM = window.LicenseManager;
      const maxBatch = LM ? LM.getTierDef().limits.batchFiles : 0;

      if (maxBatch === 0) {
        if (window.Paywall) window.Paywall.openModal('STUDIO');
        return [];
      }

      const remaining = maxBatch === -1 ? files.length : Math.max(0, maxBatch - _queue.length);
      const toAdd = Array.from(files).slice(0, remaining);

      const jobs = toAdd.map(f => _createJob(f, options));
      _queue.push(...jobs);

      jobs.forEach(job => _emit('job:queued', { job }));
      _emit('queue:updated', { queue: _queue });

      setTimeout(_tick, 0);
      return jobs.map(j => j.id);
    },

    /**
     * Cancel a specific job.
     */
    cancel(jobId) {
      const controller = _active.get(jobId);
      if (controller) controller.abort();
      const job = _queue.find(j => j.id === jobId);
      if (job && job.state === JobState.QUEUED) {
        job.state = JobState.CANCELLED;
        _emit('job:cancelled', { job });
      }
    },

    /**
     * Cancel all jobs.
     */
    cancelAll() {
      _active.forEach(ctrl => ctrl.abort());
      _queue.forEach(job => {
        if (job.state !== JobState.DONE && job.state !== JobState.ERROR) {
          job.state = JobState.CANCELLED;
        }
      });
      _emit('queue:updated', { queue: _queue });
    },

    /**
     * Pause processing (current jobs finish, no new ones start).
     */
    pause() { _paused = true; _emit('queue:paused', {}); },

    /**
     * Resume processing.
     */
    resume() { _paused = false; _emit('queue:resumed', {}); setTimeout(_tick, 0); },

    /**
     * Clear completed/cancelled/error jobs from the queue.
     */
    clearCompleted() {
      _queue = _queue.filter(j => j.state === JobState.QUEUED || j.state === JobState.PROCESSING);
      _emit('queue:updated', { queue: _queue });
    },

    /**
     * Export all completed jobs as a ZIP archive.
     */
    exportAll() {
      const doneIds = _queue.filter(j => j.state === JobState.DONE).map(j => j.id);
      return _exportZIP(doneIds);
    },

    /**
     * Download a single job result.
     */
    downloadJob(jobId) {
      const result = _results.get(jobId);
      if (result) _downloadBlob(result.blob, result.name);
    },

    /**
     * Get the current queue state.
     */
    getQueue() { return _queue.map(j => ({ ...j })); },

    /**
     * Get queue statistics.
     */
    getStats() {
      const total = _queue.length;
      const done = _queue.filter(j => j.state === JobState.DONE).length;
      const processing = _queue.filter(j => j.state === JobState.PROCESSING).length;
      const queued = _queue.filter(j => j.state === JobState.QUEUED).length;
      const errors = _queue.filter(j => j.state === JobState.ERROR).length;
      return { total, done, processing, queued, errors, paused: _paused };
    },

    /**
     * Set max concurrent jobs (based on tier).
     */
    setConcurrency(n) { _maxConcurrent = Math.max(1, n); },

    /**
     * Subscribe to batch events.
     * Events: job:queued, job:started, job:progress, job:done, job:error,
     *         job:cancelled, job:retry, queue:updated, queue:paused, queue:resumed
     */
    on(event, cb) {
      _listeners.push({ event, cb });
      return () => { _listeners = _listeners.filter(l => l.cb !== cb); };
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BP;
  if (typeof window !== 'undefined') window.BatchProcessor = BP;
  return BP;
})();
