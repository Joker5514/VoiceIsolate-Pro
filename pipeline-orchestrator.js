/* ============================================
   VoiceIsolate Pro v22.1 — PipelineOrchestrator
   Threads from Space v11 · Main Thread Conductor
   Lazy AudioContext · Worker Lifecycle · Modes
   ============================================ */

'use strict';

/**
 * Main thread conductor for VoiceIsolate Pro.
 * - Lazy AudioContext initialization (user gesture only)
 * - Worker lifecycle management (ML, DSP, AudioWorklet)
 * - SharedArrayBuffer allocation for ring buffers
 * - Mode switching: real-time ↔ offline processing
 * - Transport controls with proper pause/resume
 */
class PipelineOrchestrator {
  constructor(state) {
    this.state = state;          // PipelineState instance
    this.audioCtx = null;
    this.mlWorker = null;
    this.dspWorker = null;
    this.workletNode = null;
    this.inputRingSAB = null;
    this.maskRingSAB = null;
    this.frameSize = 4096;
    this.frameCount = 10;

    // Transport state
    this.sourceNode = null;
    this.gainNode = null;
    this.analyserNode = null;
    this.inputBuffer = null;
    this.outputBuffer = null;
    this.isPlaying = false;
    this.startedAt = 0;
    this.pauseOffset = 0;

    // Status
    this.mode = 'idle'; // idle | realtime | processing | complete
    this.sabSupported = typeof SharedArrayBuffer !== 'undefined';
    this._workletLoaded = false; // FIX 2: guard against re-registration on repeated ensureContext() calls
    this._currentPlayingBuffer = null; // FIX 14: explicit tracker for toggleAB() while paused

    // Callbacks
    this.onStatusChange = () => {};
    this.onProgress = () => {};
    this.onProcessComplete = () => {};
    this.onError = () => {};
  }

  /** Initialize AudioContext lazily inside user gesture */
  ensureContext() {
    if (this.audioCtx) return this.audioCtx;

    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000,
      latencyHint: 'interactive'
    });

    // Create persistent nodes
    this.gainNode = this.audioCtx.createGain();
    this.analyserNode = this.audioCtx.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.8;

    this.gainNode.connect(this.analyserNode);
    this.analyserNode.connect(this.audioCtx.destination);

    return this.audioCtx;
  }

  /** Initialize ML Worker */
  async initMLWorker(options = {}) {
    if (this.mlWorker) return;

    this.mlWorker = new Worker('ml-worker.js');

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ML init timeout')), 15000);

      this.mlWorker.onmessage = (e) => {
        if (e.data.type === 'ready') {
          clearTimeout(timeout);

          // Set up ring buffers if SAB supported
          if (this.sabSupported) {
            this._allocateRingBuffers();
            this.mlWorker.postMessage({
              type: 'initRingBuffers',
              inputSAB: this.inputRingSAB,
              maskSAB: this.maskRingSAB,
              frameSize: this.frameSize,
              frameCount: this.frameCount
            });
          }

          resolve(e.data);
        } else if (e.data.type === 'log') {
          console.log(`[ML] ${e.data.level}: ${e.data.msg}`);
        }
      };

      this.mlWorker.onerror = (err) => {
        clearTimeout(timeout);
        reject(err);
      };

      // FIX 1: Remove ortUrl — ml-worker.js loads ORT locally via importScripts('/lib/ort.min.js')
      this.mlWorker.postMessage({
        type: 'init',
        models: options.models || ['vad'],
        modelPaths: options.modelPaths || {}
        // ortUrl intentionally omitted — ONNX Runtime is vendored at /lib/ort.min.js
      });
    });
  }

  /** Initialize AudioWorklet for real-time processing */
  async initWorklet() {
    const ctx = this.ensureContext();
    if (this._workletLoaded) return true; // FIX 2: guard against re-registration

    try {
      await ctx.audioWorklet.addModule('voice-isolate-processor.js');
      this._workletLoaded = true;

      this.workletNode = new AudioWorkletNode(ctx, 'voice-isolate-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1]
      });

      // Set up ring buffers in worklet
      if (this.sabSupported && this.inputRingSAB && this.maskRingSAB) {
        this.workletNode.port.postMessage({
          type: 'initRingBuffers',
          inputSAB: this.inputRingSAB,
          maskSAB: this.maskRingSAB,
          frameSize: this.frameSize,
          frameCount: this.frameCount
        });
      }

      // Connect state to worklet port
      this.state.setWorkletPort(this.workletNode.port);

      // Send initial params
      const rtParams = {};
      for (const key of this.state.keys()) {
        const meta = this.state.getMeta(key);
        if (meta && meta.rt) rtParams[key] = meta.value;
      }
      this.workletNode.port.postMessage({ type: 'paramBulk', params: rtParams });

      return true;
    } catch (err) {
      console.warn('AudioWorklet unavailable:', err.message);
      this._workletLoaded = false;
      return false;
    }
  }

  /** Decode audio from File */
  async decodeFile(file) {
    const ctx = this.ensureContext();
    const arrayBuf = await file.arrayBuffer();

    try {
      this.inputBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
      return this.inputBuffer;
    } catch (_) {
      // Video files: try decoding via arrayBuffer directly
      try {
        this.inputBuffer = await ctx.decodeAudioData(arrayBuf);
        return this.inputBuffer;
      } catch (e2) {
        throw new Error('Cannot decode audio: ' + e2.message);
      }
    }
  }

  // ===== TRANSPORT CONTROLS =====

  /** Play audio (processed if available, else original) */
  play(buffer = null) {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') ctx.resume();

    const buf = buffer || this.outputBuffer || this.inputBuffer;
    if (!buf) return;

    this.stop(false); // stop without resetting offset

    this.sourceNode = ctx.createBufferSource();
    this.sourceNode.buffer = buf;

    // FIX 8: Never route file/buffer playback through worklet — worklet is for mic input only.
    // Always connect directly to gainNode for file playback.
    this.sourceNode.connect(this.gainNode);

    this.sourceNode.onended = () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.pauseOffset = 0;
        this.onStatusChange('complete');
      }
    };

    this.sourceNode.start(0, this.pauseOffset);
    this.startedAt = ctx.currentTime;
    this.isPlaying = true;
    this._currentPlayingBuffer = buf; // FIX 14: track for toggleAB()
    this.onStatusChange('playing');
  }

  /** Pause — suspend context, store position (NO reset) */
  pause() {
    if (!this.isPlaying || !this.audioCtx) return;

    this.pauseOffset += this.audioCtx.currentTime - this.startedAt;
    this.audioCtx.suspend();
    this.isPlaying = false;
    this.onStatusChange('paused');
  }

  /** Resume from paused position */
  resume() {
    // FIX 7: Just resume the context — the scheduled source resumes automatically.
    // Calling play() here would create a second BufferSourceNode, doubling output.
    if (this.isPlaying || !this.audioCtx) return;

    this.audioCtx.resume().then(() => {
      this.isPlaying = true;
      this.startedAt = this.audioCtx.currentTime - this.pauseOffset;
      this.onStatusChange('playing');
    }).catch(err => console.warn('AudioContext resume failed:', err));
  }

  /** Stop playback, reset position */
  stop(resetOffset = true) {
    if (this.sourceNode) {
      try {
        // Critical: disconnect gainNode first, clear callbacks
        this.sourceNode.onended = null;
        this.sourceNode.disconnect();
        this.sourceNode.stop();
      } catch (_) {}
      this.sourceNode = null;
    }

    if (resetOffset) this.pauseOffset = 0;
    this.isPlaying = false;
    if (resetOffset) this.onStatusChange('stopped');
  }

  /** Seek to fraction (0–1) of total duration */
  seekTo(fraction) {
    const buf = this.outputBuffer || this.inputBuffer;
    if (!buf) return;
    this.pauseOffset = fraction * buf.duration;
    if (this.isPlaying) this.play();
  }

  /** Get current playback position in seconds */
  getCurrentTime() {
    if (this.isPlaying && this.audioCtx) {
      return this.pauseOffset + (this.audioCtx.currentTime - this.startedAt);
    }
    return this.pauseOffset;
  }

  /** Get analyser node for visualizations */
  getAnalyser() {
    return this.analyserNode;
  }

  // ===== PROCESSING =====

  /** Run offline 36-stage pipeline */
  async processOffline(params = null) {
    // FIX 4: Abort and terminate any in-flight processing before starting new run
    if (this.dspWorker) {
      try {
        this.dspWorker.postMessage({ type: 'abort' });
        await new Promise(r => setTimeout(r, 50)); // brief drain
      } catch (_) {}
      this.dspWorker.terminate();
      this.dspWorker = null;
    }

    const buf = this.inputBuffer;
    if (!buf) throw new Error('No audio loaded');

    this.mode = 'processing';
    this.onStatusChange('processing');

    const audioData = buf.getChannelData(0);
    const sr = buf.sampleRate;
    const exportParams = params || this.state.export();

    return new Promise((resolve, reject) => {
      const worker = new Worker('dsp-worker.js');

      // FIX 5: declare cleanupML before the if-block so worker.onmessage can always call it
      let cleanupML = () => {};

      // If ML Worker exists, set up MessageChannel for DSP→ML communication
      if (this.mlWorker) {
        const channel = new MessageChannel();
        worker.postMessage({ type: 'setMLPort' }, [channel.port1]);

        channel.port2.onmessage = (e) => {
          this.mlWorker.postMessage(e.data, e.data.data ? [e.data.data.buffer] : []);
        };

        // FIX 5: store reference so we can remove it in all terminal cases
        const mlForwarder = (e) => {
          try { channel.port2.postMessage(e.data); } catch (_) {}
        };
        this.mlWorker.addEventListener('message', mlForwarder);

        cleanupML = () => {
          this.mlWorker?.removeEventListener('message', mlForwarder);
          channel.port2.onmessage = null;
        };
      }

      worker.onmessage = (e) => {
        const msg = e.data;
        switch (msg.type) {
          case 'progress':
            this.onProgress(msg.stage, msg.pct, msg.label);
            break;

          case 'result': {
            cleanupML(); // FIX 5: remove ML listener
            worker.terminate();
            const ctx = this.ensureContext();
            const outputBuf = ctx.createBuffer(1, msg.data.length, msg.sampleRate);
            outputBuf.getChannelData(0).set(msg.data);
            this.outputBuffer = outputBuf;
            this.mode = 'complete';
            this.onStatusChange('complete');
            this.onProcessComplete({
              buffer: outputBuf,
              stats: msg.stats
            });
            resolve(outputBuf);
            break;
          }

          case 'error':
            cleanupML(); // FIX 5: remove ML listener
            worker.terminate();
            this.mode = 'idle';
            this.onStatusChange('error');
            this.onError(msg.msg);
            reject(new Error(msg.msg));
            break;

          case 'aborted':
            cleanupML(); // FIX 5: remove ML listener
            worker.terminate();
            this.mode = 'idle';
            this.onStatusChange('idle');
            reject(new Error('Processing aborted'));
            break;
        }
      };

      worker.onerror = (err) => {
        cleanupML(); // FIX 5: remove ML listener
        worker.terminate();
        this.mode = 'idle';
        reject(err);
      };

      // Send audio data (Transferable for zero-copy)
      const dataCopy = new Float32Array(audioData);
      worker.postMessage({
        type: 'process',
        data: dataCopy,
        sampleRate: sr,
        params: exportParams
      }, [dataCopy.buffer]);

      this.dspWorker = worker;
    });
  }

  /** Abort current offline processing */
  abortProcessing() {
    if (this.dspWorker) {
      this.dspWorker.postMessage({ type: 'abort' });
    }
  }

  /** Switch to real-time mode */
  async enableRealtime() {
    const workletReady = await this.initWorklet();
    if (workletReady) {
      this.mode = 'realtime';

      // Start ML worker processing loop if available
      if (this.mlWorker && this.sabSupported) {
        this.mlWorker.postMessage({ type: 'startLoop' });
      }
    }
    return workletReady;
  }

  /** Switch to offline mode */
  disableRealtime() {
    this.mode = 'idle';
    if (this.mlWorker) {
      this.mlWorker.postMessage({ type: 'stopLoop' });
    }
  }

  /** Export processed audio as WAV ArrayBuffer */
  exportWAV(bitDepth = 16) {
    const buf = this.outputBuffer || this.inputBuffer;
    if (!buf) return null;

    const data = buf.getChannelData(0);
    if (typeof DSPCore !== 'undefined') {
      return DSPCore.encodeWAV(data, buf.sampleRate, bitDepth);
    }

    // Inline fallback
    return this._encodeWAV(data, buf.sampleRate, bitDepth);
  }

  /** A/B comparison toggle */
  toggleAB() {
    if (!this.inputBuffer || !this.outputBuffer) return;
    // FIX 14: Use explicit tracker instead of sourceNode?.buffer which is null when paused
    const next = (this._currentPlayingBuffer === this.outputBuffer)
      ? this.inputBuffer
      : this.outputBuffer;
    const wasPlaying = this.isPlaying;
    const savedOffset = wasPlaying
      ? this.pauseOffset + (this.audioCtx.currentTime - this.startedAt)
      : this.pauseOffset;
    this.stop(false);
    this.pauseOffset = savedOffset;
    this._currentPlayingBuffer = next;
    if (wasPlaying) this.play(next);
    return next === this.outputBuffer ? 'processed' : 'original';
  }

  // ===== CLEANUP =====

  /** Tear down everything */
  destroy() {
    this.stop(true);

    if (this.workletNode) {
      try { this.workletNode.disconnect(); } catch (_) {}
      this.workletNode = null;
    }

    if (this.gainNode) {
      try { this.gainNode.disconnect(); } catch (_) {}
    }

    if (this.mlWorker) {
      this.mlWorker.postMessage({ type: 'dispose' });
      this.mlWorker.terminate();
      this.mlWorker = null;
    }

    if (this.dspWorker) {
      this.dspWorker.terminate();
      this.dspWorker = null;
    }

    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close();
    }
    this.audioCtx = null;
  }

  // ===== Internal =====

  _allocateRingBuffers() {
    const headerBytes = 16;
    const dataBytes = this.frameSize * this.frameCount * Float32Array.BYTES_PER_ELEMENT;
    const totalBytes = headerBytes + dataBytes;

    this.inputRingSAB = new SharedArrayBuffer(totalBytes);
    this.maskRingSAB = new SharedArrayBuffer(totalBytes);

    // Initialize control headers
    const initCtrl = (sab) => {
      const ctrl = new Int32Array(sab, 0, 4);
      Atomics.store(ctrl, 0, 0);
      Atomics.store(ctrl, 1, 0);
      Atomics.store(ctrl, 2, this.frameSize * this.frameCount);
      Atomics.store(ctrl, 3, 0);
    };
    initCtrl(this.inputRingSAB);
    initCtrl(this.maskRingSAB);
  }

  _encodeWAV(data, sr, bits = 16) {
    const bps = bits / 8;
    const ds = data.length * bps;
    const b = new ArrayBuffer(44 + ds);
    const v = new DataView(b);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0,'RIFF'); v.setUint32(4,36+ds,true); w(8,'WAVE'); w(12,'fmt ');
    v.setUint32(16,16,true); v.setUint16(20,1,true); v.setUint16(22,1,true);
    v.setUint32(24,sr,true); v.setUint32(28,sr*bps,true);
    v.setUint16(32,bps,true); v.setUint16(34,bits,true);
    w(36,'data'); v.setUint32(40,ds,true);
    for (let i=0;i<data.length;i++) {
      v.setInt16(44+i*2, Math.max(-1,Math.min(1,data[i]))*0x7FFF, true);
    }
    return b;
  }
}

// Export
if (typeof window !== 'undefined') {
  window.PipelineOrchestrator = PipelineOrchestrator;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PipelineOrchestrator;
}
