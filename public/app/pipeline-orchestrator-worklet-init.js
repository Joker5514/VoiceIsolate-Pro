/* =============================================================================
   pipeline-orchestrator-worklet-init.js  —  VoiceIsolate Pro
   Threads from Space v8 · Worklet Initialization & 52-Slider Mapping

   Responsibilities:
     1. Load dsp-processor.js into the AudioContext's AudioWorklet scope
     2. Allocate SharedArrayBuffers for mag (worklet→ml-worker) and
        mask (ml-worker→worklet) communication
     3. Instantiate the AudioWorkletNode (dsp-processor)
     4. Wire all 52 UI sliders → port.postMessage({ type:'params', … })
        on every input event, debounced to 16ms for non-RT sliders
     5. Expose the workletNode on window._vipApp so VisualizationEngine
        can subscribe to SPECTRAL_FRAME messages

   Critical constraints (do NOT violate):
     • 100% local — no fetch() to external servers
     • Worklet module path is always a local relative URL
     • SharedArrayBuffer requires COOP/COEP headers (set in vercel.json)
     • This file must be loaded AFTER app.js (VoiceIsolatePro) and
       pipeline-orchestrator.js have been parsed
============================================================================= */

(function WorkletInitModule() {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────
  const WORKLET_PATH = './dsp-processor.js';  // relative to /app/
  const FFT_SIZE     = 4096;
  const NUM_BINS     = FFT_SIZE / 2 + 1;

  // SAB layout: [Float32 × NUM_BINS] data + [Int32 × 4] flags
  const SAB_BYTE_LEN = NUM_BINS * Float32Array.BYTES_PER_ELEMENT
                     + 4       * Int32Array.BYTES_PER_ELEMENT;

  // Debounce delay (ms) for non-real-time sliders
  const DEBOUNCE_MS = 16;

  // ── Slider → worklet param mapping ─────────────────────────────────────────
  // Each entry: [ sliderId, workletParamKey ]
  // RT sliders post immediately; non-RT sliders are debounced.
  // The full 52-slider set is enumerated here — worklet only uses the ones
  // it knows about; extras are ignored gracefully.
  const SLIDER_WORKLET_MAP = [
    // Gate
    ['gateThresh',      'gateThresh'],
    ['gateRange',       'gateRange'],
    ['gateAttack',      'gateAttack'],
    ['gateRelease',     'gateRelease'],
    ['gateHold',        'gateHold'],
    ['gateLookahead',   'gateLookahead'],
    // NR
    ['nrAmount',        'nrAmount'],
    ['nrSensitivity',   'nrSensitivity'],
    ['nrSpectralSub',   'nrSpectralSub'],
    ['nrFloor',         'nrFloor'],
    ['nrSmoothing',     'nrSmoothing'],
    // EQ (worklet passes through; OAC chain handles EQ offline)
    // De-ess
    ['deEssFreq',       'deEssFreq'],
    ['deEssAmt',        'deEssAmt'],
    // Spectral / formant
    ['specTilt',        'specTilt'],
    ['formantShift',    'formantShift'],  // worklet acknowledges; actual shift in offline pipeline
    // Voice separation
    ['voiceIso',        'voiceIso'],
    ['bgSuppress',      'bgSuppress'],
    ['voiceFocusLo',    'voiceFocusLo'],
    ['voiceFocusHi',    'voiceFocusHi'],
    ['crosstalkCancel', 'crosstalkCancel'],
    // Dereverb / harmonic
    ['derevAmt',        'derevAmt'],
    ['derevDecay',      'derevDecay'],
    ['harmRecov',       'harmRecov'],
    ['harmOrder',       'harmOrder'],
    // Output
    ['outGain',         'outGain'],
    ['dryWet',          'dryWet'],
    ['outWidth',        'outWidth'],
    // Dynamics (informational — worklet echoes to diagnostics)
    ['compThresh',      'compThresh'],
    ['compRatio',       'compRatio'],
    ['compAttack',      'compAttack'],
    ['compRelease',     'compRelease'],
    ['compKnee',        'compKnee'],
    ['compMakeup',      'compMakeup'],
    ['limThresh',       'limThresh'],
    ['limRelease',      'limRelease'],
    // EQ bands (informational)
    ['eqSub',           'eqSub'],
    ['eqBass',          'eqBass'],
    ['eqWarmth',        'eqWarmth'],
    ['eqBody',          'eqBody'],
    ['eqLowMid',        'eqLowMid'],
    ['eqMid',           'eqMid'],
    ['eqPresence',      'eqPresence'],
    ['eqClarity',       'eqClarity'],
    ['eqAir',           'eqAir'],
    ['eqBrill',         'eqBrill'],
    // Filters
    ['hpFreq',          'hpFreq'],
    ['hpQ',             'hpQ'],
    ['lpFreq',          'lpFreq'],
    ['lpQ',             'lpQ'],
    // Stereo
    ['stereoWidth',     'stereoWidth'],
    ['phaseCorr',       'phaseCorr'],
    // Dither
    ['ditherAmt',       'ditherAmt'],
  ];

  // ── WorkletInit class ───────────────────────────────────────────────────────
  class WorkletInit {
    constructor() {
      this._node      = null;   // AudioWorkletNode
      this._inputSAB  = null;
      this._outputSAB = null;
      this._debTimers = {};     // keyed by sliderId
      this._ready     = false;
    }

    // ── Public API: call once AudioContext is available ──────────────────────
    async init(audioCtx) {
      if (this._ready) return this._node;

      // 1. Load the AudioWorklet module (local path only — no external fetch)
      try {
        await audioCtx.audioWorklet.addModule(WORKLET_PATH);
      } catch (err) {
        console.error('[WorkletInit] Failed to load dsp-processor.js:', err);
        throw err;
      }

      // 2. Allocate SharedArrayBuffers (requires COOP+COEP — enforced via vercel.json)
      let processorOptions = {};
      if (typeof SharedArrayBuffer !== 'undefined') {
        this._inputSAB  = new SharedArrayBuffer(SAB_BYTE_LEN);
        this._outputSAB = new SharedArrayBuffer(SAB_BYTE_LEN);
        processorOptions = {
          inputSAB:  this._inputSAB,
          outputSAB: this._outputSAB,
        };
      } else {
        console.warn('[WorkletInit] SharedArrayBuffer unavailable — ML masks disabled. ' +
          'Ensure COOP/COEP headers are set.');
      }

      // 3. Instantiate AudioWorkletNode
      this._node = new AudioWorkletNode(audioCtx, 'dsp-processor', {
        numberOfInputs:   1,
        numberOfOutputs:  1,
        outputChannelCount: [audioCtx.destination.channelCount || 2],
        processorOptions,
      });

      // 4. Send init message with sampleRate
      this._node.port.postMessage({
        type:       'init',
        sampleRate: audioCtx.sampleRate,
      });

      // 5. Forward SABs to ml-worker (if the PipelineOrchestrator has one)
      this._forwardSABsToMlWorker();

      // 6. Attach SPECTRAL_FRAME listener so VisualizationEngine gets data
      this._node.port.addEventListener('message', (ev) => {
        if (ev.data?.type === 'SPECTRAL_FRAME') {
          // Re-dispatch as a CustomEvent so VisualizationEngine._onWorkletMessage
          // can subscribe via the standard port.addEventListener path.
          // (VisualizationEngine attaches directly in app.js attachDspWorkletToVisuals)
        }
      });
      try { this._node.port.start(); } catch (_) {}

      // 7. Expose on app for VisualizationEngine attachment
      const app = window._vipApp;
      if (app && typeof app.attachDspWorkletToVisuals === 'function') {
        app.attachDspWorkletToVisuals(this._node);
      }

      // 8. Bind all 52 slider elements → worklet param messages
      this._bindSliders();

      // 9. Send current param state from app.params (if available)
      if (app?.params) {
        this._postAllParams(app.params);
      }

      this._ready = true;
      console.info('[WorkletInit] dsp-processor AudioWorkletNode ready ✓');
      return this._node;
    }

    // ── Provide the worklet node to the caller ───────────────────────────────
    getNode() { return this._node; }
    getSABs() { return { inputSAB: this._inputSAB, outputSAB: this._outputSAB }; }

    // ── Forward SABs to ml-worker via PipelineOrchestrator ──────────────────
    _forwardSABsToMlWorker() {
      if (!this._inputSAB || !this._outputSAB) return;
      const orch = window._pipelineOrchestrator || window._vipApp?._orchestrator;
      const mlWorker = orch?.mlWorker || window._vipApp?.mlWorker;
      if (mlWorker) {
        mlWorker.postMessage({
          type:      'setSABs',
          inputSAB:  this._inputSAB,
          outputSAB: this._outputSAB,
        });
      } else {
        // ml-worker not yet available — retry once it's assigned
        const retryId = setInterval(() => {
          const w = window._pipelineOrchestrator?.mlWorker
                 || window._vipApp?.mlWorker;
          if (w) {
            clearInterval(retryId);
            w.postMessage({
              type:      'setSABs',
              inputSAB:  this._inputSAB,
              outputSAB: this._outputSAB,
            });
          }
        }, 300);
      }
    }

    // ── Send all current params in one shot ──────────────────────────────────
    _postAllParams(params) {
      if (!this._node) return;
      this._node.port.postMessage({ type: 'params', params });
    }

    // ── Bind slider input events ─────────────────────────────────────────────
    _bindSliders() {
      for (const [sliderId, workletKey] of SLIDER_WORKLET_MAP) {
        const el = document.getElementById(sliderId);
        if (!el) continue;

        const isRT = el.classList.contains('realtime');

        el.addEventListener('input', () => {
          const v = parseFloat(el.value);
          if (isRT) {
            // Real-time: post immediately
            this._postParam(workletKey, v);
          } else {
            // Non-RT: debounce to 16ms
            clearTimeout(this._debTimers[sliderId]);
            this._debTimers[sliderId] = setTimeout(() => {
              this._postParam(workletKey, v);
            }, DEBOUNCE_MS);
          }
        });
      }
    }

    // ── Post a single param update ────────────────────────────────────────────
    _postParam(key, value) {
      if (!this._node) return;
      this._node.port.postMessage({
        type:   'params',
        params: { [key]: value },
      });
    }
  }

  // ── Singleton export ────────────────────────────────────────────────────────
  const workletInit = new WorkletInit();
  window._workletInit = workletInit;

  // Auto-init when _vipApp is ready and has an AudioContext
  // Uses polling with exponential back-off (max 4s total)
  let _retryCount = 0;
  const _maxRetries = 20;
  const _retryInterval = setInterval(async () => {
    const app = window._vipApp;
    if (app?.ctx && app.ctx.state !== 'closed') {
      clearInterval(_retryInterval);
      try {
        const node = await workletInit.init(app.ctx);
        // Attach to PipelineOrchestrator if available
        const orch = window._pipelineOrchestrator || app._orchestrator;
        if (orch && typeof orch._attachWorkletNode === 'function') {
          orch._attachWorkletNode(node, workletInit.getSABs());
        }
      } catch (e) {
        console.error('[WorkletInit] Auto-init failed:', e);
      }
    } else if (++_retryCount >= _maxRetries) {
      clearInterval(_retryInterval);
      console.warn('[WorkletInit] AudioContext not ready after max retries — ' +
        'call window._workletInit.init(audioCtx) manually.');
    }
  }, 200);

})();
