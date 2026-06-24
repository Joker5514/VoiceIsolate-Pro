'use strict';

import { ingestFile } from './FileIngestion.js';

export class BatchProcessor {
  constructor(options = {}) {
    this.concurrency = clampInt(options.concurrency, 1, 16, 2);
    this.ingestFile = options.ingestFile || ingestFile;
    this.processFile = options.processFile || defaultProcessFile;
    this.onEvent = options.onEvent || null;
    this._queue = [];
    this._active = new Map();
    this._completed = [];
    this._paused = false;
    this._nextId = 1;
  }

  enqueue(files, options = {}) {
    const list = Array.isArray(files) ? files : [...(files || [])];
    const ids = [];
    for (const file of list) {
      const job = {
        id: `batch-${this._nextId++}`,
        file,
        presetId: options.presetId || null,
        state: 'queued',
        progress: 0,
        result: null,
        error: null,
      };
      this._queue.push(job);
      ids.push(job.id);
      this._emit('job:queued', this._snapshotJob(job));
    }
    return ids;
  }

  pause() {
    this._paused = true;
    this._emit('queue:paused', this.getStats());
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._emit('queue:resumed', this.getStats());
  }

  async run() {
    while ((this._queue.length > 0 || this._active.size > 0) && !this._paused) {
      while (!this._paused && this._active.size < this.concurrency && this._queue.length > 0) {
        const job = this._queue.shift();
        this._active.set(job.id, job);
        void this._runJob(job);
      }
      if (this._active.size > 0) {
        await delay(5);
      }
    }
    return this.getStats();
  }

  getQueue() {
    return [...this._queue, ...this._active.values(), ...this._completed].map((job) => this._snapshotJob(job));
  }

  getStats() {
    return {
      total: this._queue.length + this._active.size + this._completed.length,
      queued: this._queue.length,
      processing: this._active.size,
      done: this._completed.filter((job) => job.state === 'done').length,
      errors: this._completed.filter((job) => job.state === 'error').length,
      paused: this._paused,
    };
  }

  async _runJob(job) {
    try {
      job.state = 'ingesting';
      this._emit('job:started', this._snapshotJob(job));
      const ingested = await this.ingestFile(job.file, {
        onProgress: (stage) => {
          job.progress = stage === 'done' ? 35 : stage === 'resampling' ? 20 : 10;
          this._emit('job:progress', { ...this._snapshotJob(job), stage });
        },
      });
      job.state = 'processing';
      job.progress = 55;
      this._emit('job:progress', { ...this._snapshotJob(job), stage: 'processing' });
      job.result = await this.processFile({
        file: job.file,
        ingested,
        presetId: job.presetId,
        jobId: job.id,
      });
      job.state = 'done';
      job.progress = 100;
      this._emit('job:done', this._snapshotJob(job));
    } catch (err) {
      job.state = 'error';
      job.error = err?.message || String(err);
      this._emit('job:error', this._snapshotJob(job));
    } finally {
      this._active.delete(job.id);
      this._completed.push(job);
    }
  }

  _snapshotJob(job) {
    return {
      id: job.id,
      name: job.file?.name || 'untitled',
      presetId: job.presetId,
      state: job.state,
      progress: job.progress,
      error: job.error,
      result: job.result,
    };
  }

  _emit(type, payload) {
    if (this.onEvent) this.onEvent(type, payload);
  }
}

async function defaultProcessFile({ ingested, presetId, jobId }) {
  return {
    presetId,
    jobId,
    duration: ingested.duration,
    sampleRate: ingested.sampleRate,
    channels: ingested.numberOfChannels,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default BatchProcessor;