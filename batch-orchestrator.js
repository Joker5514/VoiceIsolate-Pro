/* ============================================
   VoiceIsolate Pro v20.0 — BatchOrchestrator
   Threads from Space v10 · Job Queue
   1000+ Files · Priority Queue · FFmpeg Mux
   ============================================ */

'use strict';

/**
 * Async batch processing orchestrator.
 * - Priority-sorted job queue (1–1000+ files)
 * - Configurable worker concurrency (default: navigator.hardwareConcurrency)
 * - FFmpeg integration for video muxing (copy video + AAC audio)
 * - WAV encoding with proper RIFF header
 * - Progress tracking per-file and aggregate
 */
class BatchOrchestrator {
  constructor(options = {}) {
    this.concurrency = options.concurrency || (typeof navigator !== 'undefined'
      ? navigator.hardwareConcurrency || 4 : 4);
    this.queue = [];             // sorted by priority
    this.active = new Map();     // jobId → { worker, file, status }
    this.completed = [];
    this.failed = [];
    this.nextId = 1;
    this.running = false;
    this.onProgress = options.onProgress || (() => {});
    this.onJobComplete = options.onJobComplete || (() => {});
    this.onJobError = options.onJobError || (() => {});
    this.onBatchComplete = options.onBatchComplete || (() => {});
    this.params = options.params || {};
    this._ffmpegLoaded = false;
    this._ffmpeg = null;
  }

  /**
   * Add a file to the batch queue.
   * @param {File} file
   * @param {number} priority - lower = higher priority (default 5)
   * @param {object} fileParams - per-file param overrides
   * @returns {number} jobId
   */
  enqueue(file, priority = 5, fileParams = null) {
    const id = this.nextId++;
    this.queue.push({
      id,
      file,
      priority,
      params: fileParams || this.params,
      status: 'queued',
      progress: 0,
      result: null,
      error: null
    });
    // Sort: lower priority number = higher priority
    this.queue.sort((a, b) => a.priority - b.priority);
    return id;
  }

  /**
   * Add multiple files at once.
   * @param {FileList|File[]} files
   * @param {number} priority
   * @returns {number[]} jobIds
   */
  enqueueMany(files, priority = 5) {
    const ids = [];
    for (const file of files) {
      ids.push(this.enqueue(file, priority));
    }
    return ids;
  }

  /** Start processing the queue */
  async start() {
    if (this.running) return;
    this.running = true;
    this.completed = [];
    this.failed = [];

    while (this.queue.length > 0 && this.running) {
      // Fill worker slots up to concurrency
      while (this.active.size < this.concurrency && this.queue.length > 0) {
        const job = this.queue.shift();
        this.active.set(job.id, job);
        this._processJob(job); // fire-and-forget (tracked via Map)
      }

      // Wait for any active job to complete
      if (this.active.size >= this.concurrency) {
        await new Promise(r => setTimeout(r, 100));
      }
    }

    // Wait for remaining active jobs
    while (this.active.size > 0) {
      await new Promise(r => setTimeout(r, 100));
    }

    this.running = false;
    this.onBatchComplete({
      completed: this.completed.length,
      failed: this.failed.length,
      total: this.completed.length + this.failed.length
    });
  }

  /** Stop processing (finish active, don't start new) */
  stop() {
    this.running = false;
  }

  /** Cancel all (abort active + clear queue) */
  cancel() {
    this.running = false;
    this.queue.length = 0;
    for (const [id, job] of this.active) {
      if (job.worker) {
        job.worker.postMessage({ type: 'abort' });
      }
    }
  }

  /** Get aggregate progress (0–100) */
  getProgress() {
    const total = this.completed.length + this.failed.length + this.active.size + this.queue.length;
    if (total === 0) return 100;
    const done = this.completed.length + this.failed.length;
    let activeProgress = 0;
    for (const job of this.active.values()) {
      activeProgress += (job.progress || 0) / 100;
    }
    return Math.round(((done + activeProgress) / total) * 100);
  }

  // ---- Internal ----

  async _processJob(job) {
    try {
      job.status = 'loading';

      // Decode audio from file
      const arrayBuf = await job.file.arrayBuffer();
      const audioCtx = new OfflineAudioContext(1, 1, 48000);
      let decoded;
      try {
        decoded = await audioCtx.decodeAudioData(arrayBuf.slice(0));
      } catch (_) {
        // Video files: extract audio via temporary AudioContext
        decoded = await this._decodeVideoAudio(job.file);
      }

      if (!decoded) throw new Error('Failed to decode audio');

      const audioData = decoded.getChannelData(0);
      const sr = decoded.sampleRate;

      job.status = 'processing';

      // Process via DSP Worker
      const result = await this._runDSPWorker(audioData, sr, job.params, (stage, pct) => {
        job.progress = pct;
        this.onProgress({ jobId: job.id, stage, pct, aggregate: this.getProgress() });
      });

      job.status = 'encoding';

      // Determine output format
      const isVideo = /\.(mp4|mov|webm|mkv)$/i.test(job.file.name);

      if (isVideo) {
        // FFmpeg mux: processed audio + original video
        job.result = await this._muxVideo(job.file, result.data, sr);
      } else {
        // WAV encode
        job.result = this._encodeWAV(result.data, sr);
      }

      job.status = 'complete';
      job.progress = 100;
      this.completed.push(job);
      this.onJobComplete({ jobId: job.id, file: job.file, result: job.result, stats: result.stats });

    } catch (err) {
      job.status = 'error';
      job.error = err.message;
      this.failed.push(job);
      this.onJobError({ jobId: job.id, file: job.file, error: err.message });
    } finally {
      this.active.delete(job.id);
    }
  }

  _runDSPWorker(audioData, sr, params, onProgress) {
    return new Promise((resolve, reject) => {
      const worker = new Worker('dsp-worker.js');
      const data = new Float32Array(audioData);

      worker.onmessage = (e) => {
        const msg = e.data;
        switch (msg.type) {
          case 'progress':
            onProgress(msg.stage, msg.pct);
            break;
          case 'result':
            worker.terminate();
            resolve(msg);
            break;
          case 'error':
            worker.terminate();
            reject(new Error(msg.msg));
            break;
          case 'aborted':
            worker.terminate();
            reject(new Error('Aborted'));
            break;
        }
      };

      worker.onerror = (err) => {
        worker.terminate();
        reject(err);
      };

      worker.postMessage({
        type: 'process',
        data,
        sampleRate: sr,
        params
      }, [data.buffer]);
    });
  }

  async _decodeVideoAudio(file) {
    try {
      const arrayBuf = await file.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 48000);
      return await ctx.decodeAudioData(arrayBuf);
    } catch (_) {
      return null;
    }
  }

  async _muxVideo(originalFile, processedAudio, sr) {
    // Load FFmpeg if needed
    if (!this._ffmpegLoaded) {
      await this._loadFFmpeg();
    }

    if (!this._ffmpeg) {
      // Fallback: just return WAV
      return this._encodeWAV(processedAudio, sr);
    }

    try {
      const ffmpeg = this._ffmpeg;

      // Write original video
      const videoData = new Uint8Array(await originalFile.arrayBuffer());
      ffmpeg.FS('writeFile', 'input_video', videoData);

      // Write processed audio as WAV
      const wavBuf = this._encodeWAV(processedAudio, sr);
      ffmpeg.FS('writeFile', 'processed_audio.wav', new Uint8Array(wavBuf));

      // Mux: copy video stream + AAC encode audio
      await ffmpeg.run(
        '-i', 'input_video',
        '-i', 'processed_audio.wav',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-shortest',
        'output.mp4'
      );

      const outputData = ffmpeg.FS('readFile', 'output.mp4');

      // Cleanup
      ffmpeg.FS('unlink', 'input_video');
      ffmpeg.FS('unlink', 'processed_audio.wav');
      ffmpeg.FS('unlink', 'output.mp4');

      return outputData.buffer;
    } catch (err) {
      console.warn('FFmpeg mux failed, returning WAV:', err);
      return this._encodeWAV(processedAudio, sr);
    }
  }

  async _loadFFmpeg() {
    try {
      if (typeof createFFmpeg !== 'undefined') {
        this._ffmpeg = createFFmpeg({ log: false });
        await this._ffmpeg.load();
        this._ffmpegLoaded = true;
      }
    } catch (_) {
      this._ffmpeg = null;
      this._ffmpegLoaded = false;
    }
  }

  _encodeWAV(data, sampleRate, bitDepth = 16) {
    // Use DSPCore if available
    if (typeof DSPCore !== 'undefined') {
      return DSPCore.encodeWAV(data, sampleRate, bitDepth);
    }

    // Inline WAV encoder
    const bytesPerSample = bitDepth / 8;
    const dataSize = data.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const ws = (off, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };

    ws(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    ws(8, 'WAVE');
    ws(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, bitDepth, true);
    ws(36, 'data');
    view.setUint32(40, dataSize, true);

    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i]));
      view.setInt16(44 + i * 2, s * 0x7FFF, true);
    }

    return buffer;
  }
}

// Export
if (typeof window !== 'undefined') {
  window.BatchOrchestrator = BatchOrchestrator;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BatchOrchestrator;
}
