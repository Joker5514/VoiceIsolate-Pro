/* ============================================
   VoiceIsolate Pro v22.1 — Pipeline Orchestrator
   Threads from Space v11
   ONNX Runtime Web init · AudioWorklet setup
   52-slider → AudioWorkletNode param mapping
   WebGPU > WASM fallback · SharedArrayBuffer rings
   ============================================ */

'use strict';

/**
 * PipelineOrchestrator
 * ─────────────────────
 * Owns:
 *  - The AudioContext and AudioWorkletNode (live path)
 *  - ONNX Runtime session initialisation (via ml-worker.js)
 *  - SharedArrayBuffer ring buffer allocation
 *  - Slider → worklet parameter forwarding
 *
 * Lifecycle:
 *   const orch = new PipelineOrchestrator();
 *   await orch.init();          // one-time setup
 *   orch.connectSource(srcNode) // wire microphone / file source
 *   orch.updateParams(params);  // called on every slider change
 */
export class PipelineOrchestrator {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx          = null;
    /** @type {AudioWorkletNode|null} */
    this.workletNode  = null;
    /** @type {Worker|null} */
    this.mlWorker     = null;
    /** @type {boolean} */
    this.mlReady      = false;
    /** @type {string} */
    this.mlProvider   = 'wasm';  // updated after ONNX init

    // Shared ring buffers  (allocated once, shared between worklet + ML worker)
    // Each SAB layout:  Int32[0]=writePtr, Int32[1]=readPtr, Float32[2..]
    this._ringCapacity = 32;  // slots
    this._quantumSize  = 128; // render quantum samples
    this._halfN        = 1025; // fftSize/2+1 = 2048/2+1

    // inputRing: worklet → ML worker  (raw PCM quanta)
    this._inputRingSAB = null;
    // maskRing:  ML worker → worklet  (per-bin gain mask)
    this._maskRingSAB  = null;
  }

  // ── One-time initialisation ─────────────────────────────────────────────
  /**
   * Must be called from a user-gesture handler (e.g. button click)
   * to satisfy browser autoplay policy.
   */
  async init() {
    await this._createAudioContext();
    await this._loadWorklet();
    this._allocateRings();
    await this._initMLWorker();
    this._bindSliders();
  }

  // ── AudioContext ────────────────────────────────────────────────────────
  async _createAudioContext() {
    if (this.ctx && this.ctx.state !== 'closed') {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      // Hint the browser to prefer low latency (Chrome honours this)
      latencyHint: 'interactive',
      sampleRate: 48000  // prefer 48 kHz for telephony / voice
    });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  // ── AudioWorklet loading ─────────────────────────────────────────────────
  async _loadWorklet() {
    if (!this.ctx) throw new Error('AudioContext not initialised');
    try {
      // Registers 'dsp-processor' on the audio rendering thread
      await this.ctx.audioWorklet.addModule('./dsp-processor.js');
    } catch (err) {
      console.error('[Orchestrator] Failed to load AudioWorklet module:', err);
      throw err;
    }

    this.workletNode = new AudioWorkletNode(this.ctx, 'dsp-processor', {
      numberOfInputs:  1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        frameSize:    4096,
        fftSize:      2048,
        hopSize:      512,
        ringCapacity: this._ringCapacity
      }
    });

    // Route: workletNode → destination
    this.workletNode.connect(this.ctx.destination);

    // Listen for 'ready' ack from processor
    this.workletNode.port.onmessage = (e) => {
      if (e.data.type === 'ready') {
        console.info('[Orchestrator] DSP worklet ready');
      }
    };
  }

  // ── SharedArrayBuffer ring allocation ───────────────────────────────────
  _allocateRings() {
    // Input ring: worklet writes 128-sample PCM quanta
    // Size = 2 Int32 (pointers) + capacity * quantumSize * Float32
    const inputBytes =
      Int32Array.BYTES_PER_ELEMENT * 2 +
      this._ringCapacity * this._quantumSize * Float32Array.BYTES_PER_ELEMENT;
    this._inputRingSAB = new SharedArrayBuffer(inputBytes);

    // Mask ring: ML worker writes halfN-length Float32 gain masks
    const maskBytes =
      Int32Array.BYTES_PER_ELEMENT * 2 +
      this._ringCapacity * this._halfN * Float32Array.BYTES_PER_ELEMENT;
    this._maskRingSAB = new SharedArrayBuffer(maskBytes);

    // Initialise pointers to 0
    new Int32Array(this._inputRingSAB).fill(0);
    new Int32Array(this._maskRingSAB ).fill(0);

    // Send both SABs to the worklet (zero-copy transfer via postMessage)
    this.workletNode.port.postMessage({
      type:      'initRings',
      inputRing: this._inputRingSAB,
      maskRing:  this._maskRingSAB
    });
  }

  // ── ONNX Runtime + ML Worker initialisation ─────────────────────────────
  /**
   * Spins up ml-worker.js and asks it to:
   *  1. Load onnxruntime-web with WebGPU > WASM fallback.
   *  2. Initialise the VAD model immediately (small, fast).
   *  3. Initialise Demucs + BSRNN lazily on first process() call.
   *  4. Block on Atomics.wait(inputRing) for PCM data,
   *     run inference, write mask back to maskRing.
   */
  async _initMLWorker() {
    return new Promise((resolve) => {
      this.mlWorker = new Worker('./ml-worker.js');

      this.mlWorker.onmessage = (e) => {
        const { type } = e.data;

        if (type === 'ready') {
          this.mlReady    = true;
          this.mlProvider = e.data.provider || 'wasm';
          console.info(
            `[Orchestrator] ML worker ready — provider: ${this.mlProvider}`,
            e.data.models
          );
          resolve();

        } else if (type === 'log') {
          console[e.data.level] && console[e.data.level]('[ml-worker]', e.data.msg);
        }
        // inference 'result' messages are handled by individual _mlCall() promises
      };

      this.mlWorker.onerror = (err) => {
        console.warn('[Orchestrator] ML worker error:', err.message);
        this.mlReady = false;
        resolve(); // non-fatal: pipeline runs without ML if worker fails
      };

      // ── Init message ────────────────────────────────────────────────────
      // CRITICAL: providers array order = priority.  WebGPU first, then wasm.
      // The worker will try each in order and report back which one succeeded.
      this.mlWorker.postMessage({
        type:      'init',
        ortUrl:    '/lib/ort.min.js',   // 100% local — no CDN
        providers: ['webgpu', 'wasm'],  // WebGPU > WASM fallback
        models:    ['vad'],             // eager-load only VAD; rest are lazy

        // Pass SABs so the ML worker can Atomics.wait on input and write masks
        inputRing: this._inputRingSAB,
        maskRing:  this._maskRingSAB,
        ringCapacity:  this._ringCapacity,
        quantumSize:   this._quantumSize,
        halfN:         this._halfN
      }, [
        // Transfer (not copy) the SABs  — SharedArrayBuffers are
        // transferable and will be shared between all recipients.
        // Note: postMessage with SAB does NOT detach them (unlike ArrayBuffer).
        // The transfer list here is intentionally empty because SABs are
        // shared by definition; listing them causes a TypeError in some browsers.
      ]);
    });
  }

  // ── Connect an audio source ──────────────────────────────────────────────
  /**
   * @param {AudioNode} sourceNode  e.g. AudioBufferSourceNode or MediaStreamSourceNode
   */
  connectSource(sourceNode) {
    if (!this.workletNode) throw new Error('Worklet not initialised — call init() first');
    sourceNode.connect(this.workletNode);
  }

  disconnectSource(sourceNode) {
    try { sourceNode.disconnect(this.workletNode); } catch (_) {}
  }

  // ── Slider → Worklet parameter forwarding ───────────────────────────────
  /**
   * Called by VoiceIsolatePro.onSlider() and applyPreset().
   * Forwards the full params snapshot to the AudioWorkletProcessor
   * via the message port (non-blocking, copied by the browser's
   * structured-clone algorithm).
   *
   * Only params relevant to the worklet (gate, NR, voice isolation,
   * outGain, dryWet) are forwarded — EQ/compression are handled on
   * the main-thread BiquadFilter chain.
   *
   * @param {Object} params  Full params snapshot from VoiceIsolatePro
   */
  updateParams(params) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'setParams',
      params: {
        // Noise Gate
        gateThresh:    params.gateThresh,
        gateRange:     params.gateRange,
        gateAttack:    params.gateAttack,
        gateRelease:   params.gateRelease,
        gateHold:      params.gateHold,
        gateLookahead: params.gateLookahead,
        // Spectral NR
        nrAmount:      params.nrAmount,
        nrSensitivity: params.nrSensitivity,
        nrSpectralSub: params.nrSpectralSub,
        nrFloor:       params.nrFloor,
        nrSmoothing:   params.nrSmoothing,
        // Voice Isolation
        voiceIso:      params.voiceIso,
        bgSuppress:    params.bgSuppress,
        voiceFocusLo:  params.voiceFocusLo,
        voiceFocusHi:  params.voiceFocusHi,
        // Output
        outGain:       params.outGain,
        dryWet:        params.dryWet
      }
    });

    // Also forward blend weights to the ML worker for Demucs/BSRNN mixing
    if (this.mlWorker) {
      this.mlWorker.postMessage({
        type:   'setWeights',
        demucs: params.voiceIso / 100,
        bsrnn:  1 - params.voiceIso / 100
      });
    }
  }

  // ── Bind all 52 sliders once the DOM is ready ────────────────────────────
  /**
   * Iterates every <input data-param> and wires its 'input' event to
   * updateParams().  This replaces the old VoiceIsolatePro.onSlider()
   * path for worklet-relevant params.
   *
   * Safe to call before workletNode is created — updateParams() is
   * guarded with an early return.
   */
  _bindSliders() {
    // We piggyback on the existing SLIDERS registry defined in app.js
    // All 52 sliders fire this handler; non-worklet params are simply
    // forwarded but ignored by the worklet (cheap no-op).
    document.querySelectorAll('input[type="range"][data-param]').forEach((el) => {
      el.addEventListener('input', () => {
        // Build a minimal snapshot from the current DOM state
        // (VoiceIsolatePro.params is the authoritative store;
        //  we read directly from DOM here to avoid a circular dep)
        const snapshot = {};
        document.querySelectorAll('input[type="range"][data-param]').forEach((s) => {
          snapshot[s.dataset.param] = parseFloat(s.value);
        });
        this.updateParams(snapshot);
      });
    });
  }

  // ── Suspend / resume AudioContext ────────────────────────────────────────
  async suspend() {
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  // ── Teardown ──────────────────────────────────────────────────────────────
  destroy() {
    if (this.mlWorker) { this.mlWorker.terminate(); this.mlWorker = null; }
    if (this.workletNode) { try { this.workletNode.disconnect(); } catch (_) {} this.workletNode = null; }
    if (this.ctx && this.ctx.state !== 'closed') { this.ctx.close(); this.ctx = null; }
    this.mlReady = false;
  }
}
