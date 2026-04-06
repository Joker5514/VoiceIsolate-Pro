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
 * Lifecycle (managed automatically by the bootstrap at the bottom):
 *   orch.init() is called on the first user gesture.
 *   orch.connectSource(srcNode) wires microphone / file source.
 *   orch.updateParams(params) is called on every slider change.
 *
 * NOTE: This file is loaded as a classic <script> (not ES module).
 * Do NOT add `export` or `import` statements.
 */
class PipelineOrchestrator {
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
    /** @type {boolean} */
    this.initialized  = false;
    /** @type {Promise|null} */
    this._initPromise = null;

    // Shared ring buffers  (allocated once, shared between worklet + ML worker)
    // Each SAB layout:  Int32[0]=writePtr, Int32[1]=readPtr, Float32[2..]
    this._ringCapacity = 32;   // slots
    this._quantumSize  = 128;  // render quantum samples
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
   * Safe to call multiple times — subsequent calls return the cached promise.
   */
  init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    try {
      await this._createAudioContext();
      await this._loadWorklet();
      this._allocateRings();
      await this._initMLWorker();
      this._bindSliders();
      this.initialized = true;
      console.info('[Orchestrator] Fully initialised ✓');
    } catch (err) {
      console.error('[Orchestrator] Init failed:', err);
      // Non-fatal: offline pipeline (runPipeline via DSPCore) still works
    }
  }

  // ── AudioContext ────────────────────────────────────────────────────────
  async _createAudioContext() {
    // Re-use app's existing AudioContext if available to avoid double-context
    const app = window._vipApp;
    if (app && app.ctx && app.ctx.state !== 'closed') {
      this.ctx = app.ctx;
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
      sampleRate: 48000
    });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    // Share back with app
    if (app) app.ctx = this.ctx;
  }

  // ── AudioWorklet loading ─────────────────────────────────────────────────
  async _loadWorklet() {
    if (!this.ctx) throw new Error('AudioContext not initialised');
    try {
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
    try {
      const inputBytes =
        Int32Array.BYTES_PER_ELEMENT * 2 +
        this._ringCapacity * this._quantumSize * Float32Array.BYTES_PER_ELEMENT;
      this._inputRingSAB = new SharedArrayBuffer(inputBytes);

      const maskBytes =
        Int32Array.BYTES_PER_ELEMENT * 2 +
        this._ringCapacity * this._halfN * Float32Array.BYTES_PER_ELEMENT;
      this._maskRingSAB = new SharedArrayBuffer(maskBytes);

      new Int32Array(this._inputRingSAB).fill(0);
      new Int32Array(this._maskRingSAB ).fill(0);

      this.workletNode.port.postMessage({
        type:      'initRings',
        inputRing: this._inputRingSAB,
        maskRing:  this._maskRingSAB
      });
    } catch (err) {
      // SharedArrayBuffer blocked (missing COOP/COEP) — graceful degradation
      console.warn('[Orchestrator] SharedArrayBuffer unavailable; live ML masking disabled:', err.message);
      this._inputRingSAB = null;
      this._maskRingSAB  = null;
    }
  }

  // ── ONNX Runtime + ML Worker initialisation ─────────────────────────────
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
          // Share with app instance
          if (window._vipApp) window._vipApp.mlWorker = this.mlWorker;
          resolve();
        } else if (type === 'log') {
          const lvl = e.data.level;
          if (console[lvl]) console[lvl]('[ml-worker]', e.data.msg);
        }
      };

      this.mlWorker.onerror = (err) => {
        console.warn('[Orchestrator] ML worker error:', err.message);
        this.mlReady = false;
        resolve(); // non-fatal
      };

      const msg = {
        type:      'init',
        ortUrl:    '/lib/ort.min.js',
        providers: ['webgpu', 'wasm'],
        models:    ['vad']
      };

      // Only include SABs if they were successfully allocated
      if (this._inputRingSAB && this._maskRingSAB) {
        msg.inputRing    = this._inputRingSAB;
        msg.maskRing     = this._maskRingSAB;
        msg.ringCapacity = this._ringCapacity;
        msg.quantumSize  = this._quantumSize;
        msg.halfN        = this._halfN;
      }

      this.mlWorker.postMessage(msg);
    });
  }

  // ── Connect / disconnect an audio source ────────────────────────────────
  /** @param {AudioNode} sourceNode */
  connectSource(sourceNode) {
    if (!this.workletNode) {
      console.warn('[Orchestrator] connectSource called before init()');
      return;
    }
    sourceNode.connect(this.workletNode);
  }

  disconnectSource(sourceNode) {
    try { sourceNode.disconnect(this.workletNode); } catch (_) {}
  }

  // ── Slider → Worklet parameter forwarding ───────────────────────────────
  /**
   * Called by the patched onSlider() and applyPreset() in app.js.
   * Forwards the full params snapshot to the AudioWorkletProcessor
   * via the message port.
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

  // ── Bind all 52 sliders ──────────────────────────────────────────────────
  /**
   * Iterates every <input data-param> and attaches an 'input' listener that
   * calls updateParams() with a full DOM snapshot.
   * Safe to call before workletNode is created — updateParams() guards itself.
   */
  _bindSliders() {
    document.querySelectorAll('input[type="range"][data-param]').forEach((el) => {
      el.addEventListener('input', () => {
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
    if (this.mlWorker)   { this.mlWorker.terminate();  this.mlWorker   = null; }
    if (this.workletNode){ try { this.workletNode.disconnect(); } catch (_) {} this.workletNode = null; }
    if (this.ctx && this.ctx.state !== 'closed') { this.ctx.close(); this.ctx = null; }
    this.mlReady = false;
    this.initialized = false;
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
// Waits for VoiceIsolatePro to be stored on window._vipApp, then:
//  1. Attaches orch to app.orch
//  2. Patches onSlider / applyPreset / toggleRecording
//  3. Calls orch.init() on the first user gesture (click / keydown / touchstart)
// This file is loaded AFTER app.js so window._vipApp is already set.
(function bootstrapOrchestrator() {
  function attach(app) {
    const orch = new PipelineOrchestrator();
    app.orch = orch;
    // Also expose globally for debugging
    window._vipOrch = orch;

    // ── Patch onSlider ─────────────────────────────────────────────────
    const _origOnSlider = app.onSlider.bind(app);
    app.onSlider = function (el) {
      _origOnSlider(el);
      orch.updateParams(app.params);
    };

    // ── Patch applyPreset ──────────────────────────────────────────────
    const _origApply = app.applyPreset.bind(app);
    app.applyPreset = function (name) {
      _origApply(name);
      orch.updateParams(app.params);
    };

    // ── Patch toggleRecording to ensure worklet is ready first ─────────
    const _origToggle = app.toggleRecording.bind(app);
    app.toggleRecording = async function () {
      if (!orch.initialized) {
        try { await orch.init(); } catch (e) { console.warn('[Orchestrator] init during toggleRecording failed:', e); }
      }
      return _origToggle();
    };

    // ── Lazy init on first gesture ─────────────────────────────────────
    // We defer AudioContext creation to first user interaction to satisfy
    // autoplay policy across all browsers.
    let gestureHandled = false;
    const onFirstGesture = () => {
      if (gestureHandled) return;
      gestureHandled = true;
      orch.init().catch(e => console.warn('[Orchestrator] init error:', e));
      ['click','keydown','touchstart'].forEach(ev =>
        document.removeEventListener(ev, onFirstGesture, { capture: true })
      );
    };
    ['click','keydown','touchstart'].forEach(ev =>
      document.addEventListener(ev, onFirstGesture, { capture: true, once: false })
    );

    console.info('[Orchestrator] Bootstrap complete — awaiting first user gesture');
  }

  // window._vipApp is set synchronously at the bottom of app.js
  // (DOMContentLoaded fires before scripts appended after app.js,
  //  but this script tag comes after app.js so _vipApp is set by now).
  if (window._vipApp) {
    attach(window._vipApp);
  } else {
    // Fallback poll in case script ordering changes
    let tries = 0;
    const poll = setInterval(() => {
      if (window._vipApp) { clearInterval(poll); attach(window._vipApp); }
      else if (++tries > 100) { clearInterval(poll); console.warn('[Orchestrator] window._vipApp never set'); }
    }, 50);
  }
})();
