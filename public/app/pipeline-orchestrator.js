/* ============================================
   VoiceIsolate Pro v24.0 — Pipeline Orchestrator
   Threads from Space v13
   ONNX Runtime Web init · AudioWorklet setup
   52-slider → AudioWorkletNode param mapping
   WebGPU > WASM fallback · SharedArrayBuffer rings
   ============================================ */

'use strict';

const WORKLET_READY_FALLBACK_MS = 250;
// WARNING: Update this hash whenever dsp-processor.js is modified.
// Run: node -e "const c=require('crypto'),f=require('fs');
//   console.log(c.createHash('sha256').update(f.readFileSync('public/app/dsp-processor.js')).digest('hex'))"
const WORKLET_SOURCE_SHA256 = '9f0577b157461bff5e47cb1ba46ea538d902335fb1ead315c25a86e9d1812a48';

// ─── AudioWorklet loader with CDN fallback ─────────────────────────────────
// Primary path is same-origin /app/dsp-processor.js (COOP+COEP friendly).
// If that fails (404, offline, etc.) we walk the manifest mirrors —
// Vercel Blob only — fetch the source text, wrap it in a same-origin
// Blob URL, and pass that to addModule(). The Blob URL is same-origin
// so it satisfies COEP require-corp without needing the remote response
// to carry CORP headers. Cloudflare R2 removed.
const _WORKLET_FALLBACK_CACHE = { manifest: null, sourceText: null };
async function _getWorkletManifest() {
  if (_WORKLET_FALLBACK_CACHE.manifest) return _WORKLET_FALLBACK_CACHE.manifest;
  try {
    const resp = await fetch('/app/models-manifest.json', { credentials: 'omit' });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const json = await resp.json();
    _WORKLET_FALLBACK_CACHE.manifest = json;
    return json;
  } catch {
    return null;
  }
}
function _digestToHex(digestBuffer) {
  const bytes = new Uint8Array(digestBuffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}
async function _sha256Hex(text) {
  if (!crypto || !crypto.subtle) throw new Error('crypto.subtle unavailable for worklet integrity check');
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return _digestToHex(digest);
}
async function loadDspProcessorWorklet(ctx) {
  if (!ctx || !ctx.audioWorklet) throw new Error('AudioContext.audioWorklet unavailable');

  // 1. Same-origin primary path
  try {
    await ctx.audioWorklet.addModule('/app/dsp-processor.js');
    return 'same-origin';
  } catch (primaryErr) {
    console.warn('[Orchestrator] Same-origin worklet load failed, trying CDN mirrors:', primaryErr && primaryErr.message);
  }

  // 2. Re-use a previously verified source body if one is cached this session
  if (_WORKLET_FALLBACK_CACHE.sourceText) {
    const cachedBlobUrl = URL.createObjectURL(
      new Blob([_WORKLET_FALLBACK_CACHE.sourceText], { type: 'application/javascript' })
    );
    try {
      await ctx.audioWorklet.addModule(cachedBlobUrl);
      return 'blob-cached';
    } catch {
      _WORKLET_FALLBACK_CACHE.sourceText = null;
    } finally {
      URL.revokeObjectURL(cachedBlobUrl);
    }
  }

  // 3. Walk CDN mirrors from the manifest
  const manifest = await _getWorkletManifest();
  const sources = manifest && manifest.worklets && manifest.worklets.dsp_processor
    ? manifest.worklets.dsp_processor.sources
    : [
        { provider: 'same-origin', url: '/app/dsp-processor.js', sha256: WORKLET_SOURCE_SHA256 },
        { provider: 'vercel-blob', url: 'https://blob.vercel-storage.com/voiceisolate-pro/worklets/dsp-processor.js', sha256: WORKLET_SOURCE_SHA256 },
      ];

  let lastErr;
  for (const src of sources) {
    if (src.provider === 'same-origin') continue; // already tried in step 1
    try {
      const resp = await fetch(src.url, { mode: 'cors', credentials: 'omit' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = await resp.text();
      // Basic sanity guard — must register the canonical processor name
      if (!text.includes("registerProcessor('dsp-processor'") &&
          !text.includes('registerProcessor("dsp-processor"')) {
        throw new Error('mirror does not contain dsp-processor registration');
      }
      const expectedSha256 = src && typeof src.sha256 === 'string' ? src.sha256.toLowerCase() : '';
      if (!expectedSha256) throw new Error('mirror missing required sha256 pin');
      const actualSha256 = await _sha256Hex(text);
      if (actualSha256 !== expectedSha256) {
        throw new Error('worklet integrity mismatch: expected ' + expectedSha256 + ' got ' + actualSha256);
      }
      const blob = new Blob([text], { type: 'application/javascript' });
      const blobUrl = URL.createObjectURL(blob);
      try {
        await ctx.audioWorklet.addModule(blobUrl);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      _WORKLET_FALLBACK_CACHE.sourceText = text;
      console.info('[Orchestrator] AudioWorklet loaded from CDN mirror:', src.provider);
      return src.provider;
    } catch (err) {
      lastErr = err;
      console.warn('[Orchestrator] Worklet mirror', src.provider, 'failed:', err && err.message);
    }
  }
  throw new Error('All worklet sources failed' + (lastErr ? ': ' + lastErr.message : ''));
}
// Expose for tests + diagnostics; keeps the helper available without polluting globals further.
if (typeof self !== 'undefined') self.loadDspProcessorWorklet = loadDspProcessorWorklet;

// NOTE: voice-isolate-processor.js exists in public/app/ but is NEVER registered via
// new AudioWorkletNode(ctx, 'voice-isolate-processor') anywhere in the codebase.
// It is a dead file kept for historical reference only. It can be removed in a future
// cleanup pass along with its header rule in vercel.json and its sw.js cache entry.

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
    /** @type {boolean} */
    this.workletReady = false;
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

    // Cached ML worker init promise — allows idempotent pre-warming before gesture
    this._mlInitPromise = null;

    this._isolationParams = {
      isolationMethod: 'hybrid',
      ecapaSimilarityThreshold: 0.65,
      backgroundVolume: 0,
      maskRefinement: true,
    };
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
      const sabOk = this._allocateRings();
      if (!sabOk) {
        console.warn('[Orchestrator] Live ML masking unavailable — SAB not supported; falling back to Creator mode');
      }
      await this._initMLWorker();
      this._bindSliders();
      this.initialized = true;
      // Isolation controls are also bound eagerly in the bootstrap (so they
      // work even if AudioContext / worklet init fails). Calling here is
      // idempotent — duplicate listeners are guarded by _isolationBindingsAttached.
      this._bindIsolationControls();
      console.info('[Orchestrator] Fully initialised ✓');
    } catch (err) {
      console.error('[Orchestrator] Init failed:', err);
      // Non-fatal: offline pipeline (runPipeline via DSPCore) still works
    }
  }

  // ── AudioContext ────────────────────────────────────────────────────────
  async _createAudioContext() {
    // Re-use pre-warmed suspended ctx if available (set by bootstrapOrchestrator prewarm)
    if (this._preWarmedCtx && this._preWarmedCtx.state !== 'closed') {
      this.ctx = this._preWarmedCtx;
      this._preWarmedCtx = null;
      this._workletModulesLoaded = true;
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const app = window._vipApp;
      if (app) app.ctx = this.ctx;
      return;
    }
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
    if (!this._workletModulesLoaded) {
      try {
        await loadDspProcessorWorklet(this.ctx);
        this._workletModulesLoaded = true;
        console.info('[Orchestrator] AudioWorklet modules loaded');
      } catch (err) {
        console.error('[Orchestrator] Failed to load AudioWorklet module:', err);
        throw err;
      }
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

    // NOTE: Do NOT connect workletNode → destination here.
    // buildLiveChain() in app.js owns the full routing chain:
    //   Source → WorkletNode → GainNode → Analyser → Destination
    // Connecting here would cause double-routing.

    // Listen for 'ready' ack from processor
    this.workletNode.port.onmessage = (e) => {
      if (e.data.type === 'ready') {
        this.workletReady = true;
        console.info('[Orchestrator] DSP worklet ready');
      } else if (e.data.type === 'error') {
        console.warn('[Orchestrator] DSP worklet error:', e.data.msg);
      }
    };
  }

  // ── SharedArrayBuffer ring allocation ───────────────────────────────────
  // Uses SharedRingBuffer (ring-buffer.js) for consistent 4-slot Int32 header
  // layout that is compatible with the ML worker's SAB_HEADER_BYTES = 16.
  _allocateRings() {
    // Guard: SharedArrayBuffer requires COOP+COEP headers — check before
    // attempting allocation so we get a clean boolean return rather than
    // relying solely on the catch branch.
    if (typeof SharedArrayBuffer === 'undefined' || !self.crossOriginIsolated ||
        typeof SharedRingBuffer === 'undefined' ||
        !SharedRingBuffer.isSupported()) {
      console.warn('[Orchestrator] SharedArrayBuffer unavailable — live ML masking disabled');
      this._inputRingSAB = null;
      this._maskRingSAB  = null;
      this._emitSabUnavailable('SharedArrayBuffer is not defined');
      setTimeout(() => {
        if (!this.workletReady) {
          this.workletReady = true;
        }
      }, WORKLET_READY_FALLBACK_MS);
      return false;
    }
    try {
      // Use SharedRingBuffer for consistent layout (4×Int32 header + Float32 data).
      // frameSize = samples per quantum/bin, frameCount = ring capacity slots.
      const inputRing = new SharedRingBuffer(this._quantumSize, this._ringCapacity);
      const maskRing  = new SharedRingBuffer(this._halfN,        this._ringCapacity);

      this._inputRingSAB = inputRing.getBuffer();
      this._maskRingSAB  = maskRing.getBuffer();

      this.workletNode.port.postMessage({
        type:      'initRings',
        inputRing: this._inputRingSAB,
        maskRing:  this._maskRingSAB
      });

      // Forward SABs to ML worker if it was pre-warmed before the gesture
      if (this.mlWorker) {
        this.mlWorker.postMessage({
          type:         'initRingBuffers',
          inputRing:    this._inputRingSAB,
          maskRing:     this._maskRingSAB,
          ringCapacity: this._ringCapacity,
          quantumSize:  this._quantumSize,
          halfN:        this._halfN
        });
      }
      // Some worklets acknowledge ring init asynchronously. If no explicit
      // ready message arrives, fall back after a short grace period.
      setTimeout(() => {
        if (!this.workletReady) {
          this.workletReady = true;
        }
      }, WORKLET_READY_FALLBACK_MS);
      return true;
    } catch (err) {
      // SharedArrayBuffer blocked (missing COOP/COEP) — graceful degradation
      console.warn('[Orchestrator] SharedArrayBuffer unavailable; live ML masking disabled:', err.message);
      this._inputRingSAB = null;
      this._maskRingSAB  = null;
      this._emitSabUnavailable(err?.message || String(err));
      setTimeout(() => {
        if (!this.workletReady) {
          this.workletReady = true;
        }
      }, WORKLET_READY_FALLBACK_MS);
      return false;
    }
  }

  // ── Emit sabUnavailable event (best-effort) ──────────────────────────────
  _emitSabUnavailable(reason) {
    try {
      if (typeof globalThis !== 'undefined' && typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
        globalThis.dispatchEvent(new CustomEvent('sabUnavailable', {
          detail: { reason }
        }));
      }
    } catch (_) { /* event dispatch is best-effort */ }
  }

  async waitForReadiness(timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.workletReady && this.mlReady) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  }

  // ── ONNX Runtime + ML Worker initialisation ─────────────────────────────
  // Idempotent: safe to call immediately at bootstrap (no user gesture needed
  // for Web Workers) AND again from _doInit() — returns the cached promise.
  _initMLWorker() {
    if (this._mlInitPromise) return this._mlInitPromise;
    this._mlInitPromise = this._doInitMLWorker();
    return this._mlInitPromise;
  }

  async _doInitMLWorker() {
    return new Promise((resolve) => {
      // ── Construct the ML Worker ──────────────────────────────────────────
      this.mlWorker = new Worker('/app/ml-worker.js');

      // ── Standard message handler (must be set BEFORE _mlWorkerPatch so the
      //    patch wraps this handler and can forward messages to it) ──────────
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
          // Re-send any isolation config and sound mutes that the user may
          // have changed before the worker became ready.
          try {
            this.mlWorker.postMessage({
              type: 'setIsolationConfig',
              payload: this._isolationParams,
            });
            const sm = window._vipApp && window._vipApp.soundMutes;
            if (sm && Object.keys(sm).length) {
              this.mlWorker.postMessage({ type: 'setSoundMutes', payload: sm });
            }
            // Attach the worker to the isolation-controls module so any
            // speaker cards bound before the worker came online now route
            // mute/solo/isolate/enroll messages through.
            if (typeof window._attachMLWorkerToIsolation === 'function') {
              window._attachMLWorkerToIsolation(this.mlWorker);
            }
          } catch (_) { /* best-effort */ }
          resolve();
        } else if (type === 'log') {
          const lvl = e.data.level;
          if (console[lvl]) console[lvl]('[ml-worker]', e.data.msg);
        } else if (type === 'vad_status') {
          if (window._vipApp) window._vipApp.vadModelMissing = !!e.data.vadModelMissing;
          if (e.data.vadModelMissing) {
            console.warn('[Orchestrator] Fallback VAD active (Silero model missing)');
          }
        } else if (type === 'diarization') {
          // ── Diarization result → update app state + timeline + speaker cards
          const { segments = [], duration = 0, speakerCount = 0 } = e.data;
          const app = window._vipApp;
          if (app && app.diarizationState) {
            app.diarizationState.history     = segments;
            app.diarizationState.numSpeakers = speakerCount ||
              new Set(segments.map(s => s.speakerId)).size;
            app.diarizationState.isActive    = segments.length > 0;
            app.diarizationState.confidence  = segments.length > 0
              ? segments.reduce((a, s) => a + (s.confidence || 1), 0) / segments.length : 1;
          }
          if (typeof window.onDiarizationResult === 'function')
            window.onDiarizationResult({ segments, duration, speakerCount });
          if (typeof window.updateSpeakerCards === 'function') {
            const palette = ['#3b82f6','#a855f7','#10b981','#f59e0b',
                             '#ef4444','#06b6d4','#84cc16','#f97316'];
            const map = {};  let ci = 0;
            segments.forEach(seg => {
              if (!map[seg.speakerId]) map[seg.speakerId] = {
                label: seg.label || ('Speaker ' + seg.speakerId),
                color: palette[ci++ % palette.length],
                volume: 1.0, muted: false, solo: false
              };
            });
            window.updateSpeakerCards(map);
          }
        } else if (type === 'voiceprintEnrolled') {
          const el = document.getElementById('voiceprintStatus');
          if (el) { el.textContent = '✓ Enrolled'; el.style.color = '#10b981'; }
        } else if (type === 'voiceprintCleared') {
          const el = document.getElementById('voiceprintStatus');
          if (el) { el.textContent = 'Not enrolled'; el.style.color = '#9ca3af'; }
        }
      };

      this.mlWorker.onerror = (err) => {
        console.warn('[Orchestrator] ML worker error:', err.message);
        this.mlReady = false;
        resolve(); // non-fatal — DSP passthrough still runs
      };

      // ── Apply graceful-degradation patch (ml-worker-models-patch.js) ────
      // Must come AFTER onmessage is set so the patch wraps the real handler.
      // Stamps ⚠ DSP badges on pipeline stage UI elements for any missing
      // .onnx files. Non-destructive — worker still functions without models.
      if (typeof window._mlWorkerPatch === 'function') {
        window._mlWorkerPatch(this.mlWorker, {
          logToConsole: true,
          onWarning: (stageId, modelKey, meta) => {
            // Stamp individual stage badge
            const el = document.querySelector(
              `[data-stage-id="${stageId}"], [data-stage="${stageId}"]`
            );
            if (!el) return;
            const existing = el.querySelector('.vip-stage-ml-status');
            if (existing) existing.remove();
            const badge = document.createElement('span');
            badge.className    = 'vip-stage-ml-status';
            badge.textContent  = '⚠ DSP';
            badge.style.cssText =
              'color:#f59e0b;font-size:10px;font-weight:700;' +
              'margin-left:4px;cursor:help;vertical-align:middle;';
            badge.title =
              `${meta.stageName || modelKey}: model file absent\n` +
              `Expected: models/${meta.filename || modelKey + '.onnx'}\n` +
              `Stage running in DSP passthrough mode.`;
            const label =
              el.querySelector('.stage-name,.stage-label,h4,h3,span') || el;
            label.appendChild(badge);
          },
          onManifest: (manifest) => {
            if (typeof window._stampPipelineStages === 'function') {
              window._stampPipelineStages(manifest);
            }
          }
        });
      }

      // ── Apply IndexedDB model cache patch (ml-worker-fetch-cache.js) ────
      // If models are cached in IDB, pass Object URLs so the worker skips
      // re-fetching them from disk. Falls back gracefully if cache is empty.
      if (typeof window._vipPreloadModels === 'function') {
        // Fire-and-forget preload of the two small models — silero_vad (~2.3 MB)
        // and rnnoise (~2 MB). These keys match ml-worker-fetch-cache.js MODEL_REGISTRY.
        // demucs_v4 (~87 MB) and bsrnn_vocals (~3.9 MB) are intentionally excluded:
        // loading them here pulled 90+ MB into the main-thread renderer before the
        // user could interact, causing "Aw, Snap!" OOM crashes on mobile. Both are
        // fetched on-demand by the ml-worker the first time the pipeline needs them.
        window._vipPreloadModels(
          ['silero_vad', 'rnnoise'],
          { forceRefresh: false }
        ).then((modelPaths) => {
          // Forward any resolved Object URLs to the already-running worker.
          // The preload cache uses fetch-cache keys, but ml-worker resolves
          // overrides by canonical model IDs (e.g. "vad") or filenames
          // (e.g. "silero_vad.onnx"). Preserve original keys and add the
          // worker-compatible aliases so cached blob URLs are actually used.
          const cacheKeyAliases = {
            silero_vad: ['vad', 'silero_vad.onnx'],
            rnnoise: ['rnnoise', 'rnnoise.onnx'],
            demucs_v4: ['demucs', 'demucs_v4.onnx'],
            bsrnn_vocals: ['bsrnn', 'bsrnn_vocals.onnx']
          };
          const cached = Object.keys(modelPaths);
          if (cached.length > 0) {
            const normalizedModelPaths = {};
            for (const cacheKey of cached) {
              const modelUrl = modelPaths[cacheKey];
              if (!modelUrl) continue;
              normalizedModelPaths[cacheKey] = modelUrl;
              const aliases = cacheKeyAliases[cacheKey] || [];
              for (const alias of aliases) {
                normalizedModelPaths[alias] = modelUrl;
              }
            }
            this.mlWorker.postMessage({
              type: 'cacheModelPaths',
              modelPaths: normalizedModelPaths
            });
            console.info(
              `[Orchestrator] Forwarded ${cached.length} cached model URL(s) to ML worker:`,
              Object.keys(normalizedModelPaths)
            );
          }
        }).catch((err) => {
          // Preload failure is fully non-fatal — DSP passthrough continues
          console.warn('[Orchestrator] Model preload warning:', err.message);
        });
      }

      // ── Init message ─────────────────────────────────────────────────────
      // SABs are NOT included here — they may not be allocated yet when the
      // worker is pre-warmed before the first gesture. They are forwarded
      // separately via 'initRingBuffers' inside _allocateRings() once ready.
      // payload wrapper is required: the worker's 'init' handler destructures
      // allowedModels / preferredProviders from ev.data.payload, not top-level.
      this.mlWorker.postMessage({
        type:      'init',
        ortUrl:    '/lib/ort.min.js',
        providers: ['webgpu', 'wasm'],
        payload: {
          modelBasePath:      '/app/models/',
          ortUrl:             '/lib/ort.min.js',
          preferredProviders: ['webgpu', 'wasm'],
          sampleRate:         this.audioContext ? this.audioContext.sampleRate : 48000,
          // Start the worker with only small/eager models. Large models like
          // demucs-v4 (~87 MB) are excluded from init — the ml-worker loads
          // them on-demand when inference is first requested for that model,
          // avoiding OOM crashes on mobile during app startup.
          allowedModels:      (window.Auth ? window.Auth.getCaps().mlModels : ['vad', 'rnnoise'])
            .filter(m => !['demucs', 'demucs-v4', 'demucs_v4'].includes(m)),
          allowedStages:      window.Auth ? window.Auth.getAllowedStages() : 8,
        },
      });
    });
  }

  // ── Connect / disconnect an audio source ────────────────────────────────
  /**
   * Connect an audio source to the pipeline. Synchronous when the pipeline
   * is already ready; otherwise defers the actual connection until readiness
   * (or until timeout) so callers don't silently drop the source.
   * @param {AudioNode} sourceNode
   * @returns {Promise<boolean>} resolves true if connected, false otherwise.
   */
  connectSource(sourceNode) {
    if (!this.workletNode) {
      console.warn('[Orchestrator] connectSource called before init()');
      return Promise.resolve(false);
    }
    if (this.workletReady && this.mlReady) {
      sourceNode.connect(this.workletNode);
      return Promise.resolve(true);
    }
    // Deferred connect: wait for readiness, then connect.
    return this.waitForReadiness().then((ready) => {
      if (!ready) {
        console.warn('[Orchestrator] connectSource timed out waiting for readiness', {
          workletReady: this.workletReady,
          workerReady:  this.mlReady
        });
        return false;
      }
      if (!this.workletNode) return false;
      try { sourceNode.connect(this.workletNode); } catch (_) { return false; }
      return true;
    });
  }

  disconnectSource(sourceNode) {
    try { sourceNode.disconnect(this.workletNode); } catch (_) {}
  }

  // ── Normalize raw UI params to worklet-ready values ──────────────────────
  // Mirrors the transforms defined in slider-map.js SLIDER_REGISTRY.
  // Only nrAmount (0-100% → 0-1) and dryWet (0-100% → 0-1) need scaling;
  // all other params have identity transforms and pass through unchanged.
  _normalizeRawParams(raw) {
    const p = { ...raw };
    if (typeof p.nrAmount === 'number') p.nrAmount = p.nrAmount / 100;
    if (typeof p.dryWet  === 'number') p.dryWet  = p.dryWet  / 100;
    return p;
  }

  // ── Slider → Worklet parameter forwarding ───────────────────────────────
  /**
   * Forwards a ALREADY-TRANSFORMED params snapshot to the
   * AudioWorkletProcessor via the message port.
   *
   * Callers MUST pass worklet-ready values (use _normalizeRawParams()
   * or SLIDER_REGISTRY transforms before calling).  No /100 scaling
   * is performed here to avoid double-normalisation.
   *
   * @param {Object} params  Transformed params snapshot
   */
  updateParams(params) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'setParams',
      params: params
    });

    // Forward blend weights to ML worker safely
    if (this.mlWorker) {
      // voiceIso has identity transform in SLIDER_REGISTRY → still raw 0-100
      if (params.voiceIso !== undefined && !Number.isNaN(params.voiceIso)) {
        this.mlWorker.postMessage({
          type:   'setWeights',
          demucs: params.voiceIso / 100,
          bsrnn:  1 - params.voiceIso / 100
        });
      }
      const payload = {};
      if (params.spectralFloor !== undefined) payload.spectralFloor = params.spectralFloor;
      // nrAmount arrives already normalised to 0-1 by the caller
      if (params.nrAmount !== undefined) payload.noiseReduce = Math.max(0, Math.min(1, params.nrAmount));
      if (window._vipApp && window._vipApp.forensicMode !== undefined) {
        payload.forensicMode = !!window._vipApp.forensicMode;
      }
      if (Object.keys(payload).length > 0) {
        this.mlWorker.postMessage({
          type: 'setParams',
          payload
        });
      }
    }
  }

  // ── syncParams — alias used by applyPreset during live mode ────────────────
  syncParams(params) {
    if (!params || typeof params !== 'object') return;
    this.updateParams(this._normalizeRawParams(params));
  }

  // ── run — offline DSP pipeline (called by app.js runPipeline) ───────────────
  /**
   * Process an already-decoded AudioBuffer through the DSP chain.
   * Applies: HP/LP filters, 10-band EQ, de-esser, compressor, limiter,
   * output gain, and dry/wet mix — driven entirely by VIP_PARAMS keys.
   *
   * @param {AudioBuffer} audioBuffer  Decoded input audio
   * @param {Object}      params       Raw slider values (window.VIP_PARAMS format)
   * @returns {Promise<AudioBuffer>}   Processed audio
   */
  async run(audioBuffer, params = {}) {
    if (!audioBuffer) return null;
    const p   = params;
    const sr  = audioBuffer.sampleRate;
    const nCh = audioBuffer.numberOfChannels;
    const len = audioBuffer.length;
    const DSP = (typeof window !== 'undefined' && window.DSPCore) ||
                (typeof globalThis !== 'undefined' && globalThis.DSPCore);

    // ── Stage 1: noise gate + Web Audio chain ─────────────────────────────
    const gateThreshDb   = p.gateThresh ?? -42;
    const gateActive     = gateThreshDb > -79;
    const gateThreshLin  = Math.pow(10, gateThreshDb / 20);
    const gateRangeLin   = Math.pow(10, (p.gateRange ?? -60) / 20);
    const gateAttCoef    = gateActive ? Math.exp(-1 / (Math.max(0.001, (p.gateAttack  ?? 5)   / 1000) * sr)) : 0;
    const gateRelCoef    = gateActive ? Math.exp(-1 / (Math.max(0.01,  (p.gateRelease ?? 200) / 1000) * sr)) : 0;
    const gateHoldSmp    = Math.round((p.gateHold ?? 50) / 1000 * sr);

    const offline = new OfflineAudioContext(nCh, len, sr);

    // Build gated input buffer (noise gate applied per-sample on raw audio)
    const inputBuf = offline.createBuffer(nCh, len, sr);
    for (let ch = 0; ch < nCh; ch++) {
      const src = audioBuffer.getChannelData(ch);
      const dst = inputBuf.getChannelData(ch);
      if (gateActive) {
        let env = 0, gGain = 1, hold = 0;
        for (let i = 0; i < len; i++) {
          const lvl = Math.abs(src[i]);
          env = lvl > env
            ? lvl + gateAttCoef * (env - lvl)
            : lvl + gateRelCoef * (env - lvl);
          if (env >= gateThreshLin) { gGain = 1; hold = gateHoldSmp; }
          else if (hold > 0)        { hold--;     gGain = 1; }
          else                       { gGain = gateRangeLin; }
          dst[i] = src[i] * gGain;
        }
      } else {
        dst.set(src);
      }
    }

    const srcNode = offline.createBufferSource();
    srcNode.buffer = inputBuf;
    let chain = srcNode;

    // HP filter
    const hp = offline.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = Math.max(20, Math.min(sr / 2 - 1, p.hpFreq ?? 80));
    hp.Q.value = Math.max(0.1, p.hpQ ?? 0.7);
    chain.connect(hp); chain = hp;

    // LP filter
    const lp = offline.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.max(20, Math.min(sr / 2 - 1, p.lpFreq ?? 18000));
    lp.Q.value = Math.max(0.1, p.lpQ ?? 0.7);
    chain.connect(lp); chain = lp;

    // 10-band EQ
    const eqFreqs = [40, 120, 350, 700, 1500, 3000, 5000, 8000, 12000, 18000];
    const eqKeys  = ['eqSub','eqBass','eqWarmth','eqBody','eqLowMid',
                     'eqMid','eqPresence','eqClarity','eqAir','eqBrill'];
    for (let i = 0; i < 10; i++) {
      const gain = p[eqKeys[i]] ?? 0;
      if (Math.abs(gain) < 0.01) continue;
      const eq = offline.createBiquadFilter();
      eq.type = 'peaking';
      eq.frequency.value = Math.min(eqFreqs[i], sr / 2 - 100);
      eq.gain.value = Math.max(-12, Math.min(12, gain));
      eq.Q.value = 1.4;
      chain.connect(eq); chain = eq;
    }

    // De-esser
    const deEssAmt = p.deEssAmt ?? 0;
    if (deEssAmt > 0) {
      const de = offline.createBiquadFilter();
      de.type = 'peaking';
      de.frequency.value = Math.min(p.deEssFreq ?? 6000, sr / 2 - 100);
      de.gain.value = -deEssAmt;
      de.Q.value = 2.0;
      chain.connect(de); chain = de;
    }

    // Compressor
    const comp = offline.createDynamicsCompressor();
    comp.threshold.value = p.compThresh ?? -24;
    comp.ratio.value     = Math.max(1, p.compRatio ?? 4);
    comp.attack.value    = Math.max(0.001, (p.compAttack  ?? 10)  / 1000);
    comp.release.value   = Math.max(0.01,  (p.compRelease ?? 150) / 1000);
    comp.knee.value      = Math.max(0, p.compKnee ?? 6);
    chain.connect(comp); chain = comp;

    // Makeup gain
    const makeup = offline.createGain();
    makeup.gain.value = Math.pow(10, (p.compMakeup ?? 0) / 20);
    chain.connect(makeup); chain = makeup;

    // Limiter
    const lim = offline.createDynamicsCompressor();
    lim.threshold.value = p.limThresh ?? -1;
    lim.ratio.value     = 20;
    lim.attack.value    = 0.001;
    lim.release.value   = Math.max(0.01, (p.limRelease ?? 50) / 1000);
    lim.knee.value      = 0;
    chain.connect(lim); chain = lim;

    // Output gain
    const outGainNode = offline.createGain();
    outGainNode.gain.value = Math.pow(10, (p.outGain ?? 0) / 20);
    chain.connect(outGainNode);
    outGainNode.connect(offline.destination);

    srcNode.start(0);
    const webaudioBuf = await offline.startRendering();

    // ── Stage 2: Spectral processing — single STFT pass per channel ────────
    // All spectral ops (NR, voice isolation, spectral gate) run in-place
    // between ONE forwardSTFT and ONE inverseSTFT (architecture rule).
    const nrAmount   = p.nrAmount   ?? 0;   // 0-100
    const voiceIso   = p.voiceIso   ?? 0;   // 0-100
    const bgSuppress = p.bgSuppress ?? 0;   // 0-100
    const needsSpec  = DSP && (nrAmount > 1 || voiceIso > 1 || bgSuppress > 1);

    let procBuf = webaudioBuf;

    if (needsSpec) {
      const fftSize  = 4096;
      const hopSize  = 1024;
      const halfN    = fftSize / 2 + 1;
      const binHz    = (sr / 2) / (halfN - 1);
      const resultBuf = (new OfflineAudioContext(nCh, len, sr)).createBuffer(nCh, len, sr);

      for (let ch = 0; ch < nCh; ch++) {
        const chData = webaudioBuf.getChannelData(ch);

        // ONE forward STFT
        const { mag, phase, frameCount } = DSP.forwardSTFT(chData, fftSize, hopSize);
        if (frameCount === 0) { resultBuf.copyToChannel(chData, ch); continue; }

        // Spectral NR: Wiener MMSE using minimum-statistics noise estimate.
        // Sorts frames by energy and averages the quietest 25% as the noise
        // floor reference — no VAD required, works on any signal.
        if (nrAmount > 1) {
          const frameEnergies = mag.map(m => {
            let e = 0;
            for (let k = 0; k < m.length; k++) e += m[k] * m[k];
            return e;
          });
          const sortedIdx = frameEnergies.map((_, i) => i)
            .sort((a, b) => frameEnergies[a] - frameEnergies[b]);
          const nNoise = Math.max(1, Math.floor(sortedIdx.length * 0.25));
          const noiseProfile = new Float32Array(halfN);
          for (let j = 0; j < nNoise; j++) {
            const m = mag[sortedIdx[j]];
            for (let k = 0; k < halfN; k++) noiseProfile[k] += m[k];
          }
          for (let k = 0; k < halfN; k++) noiseProfile[k] /= nNoise;
          // Scale by over-subtraction factor (sensitivity 0-100 → 1.0-3.0×)
          const overSub = 1.0 + ((p.nrSensitivity ?? 60) / 100) * 2.0;
          for (let k = 0; k < halfN; k++) noiseProfile[k] *= overSub;
          DSP.wienerMMSE(mag, noiseProfile, nrAmount);  // amount 0-100
        }

        // Voice isolation: attenuate out-of-band energy
        if (voiceIso > 1 || bgSuppress > 1) {
          const focusLo = Math.max(20, p.voiceFocusLo ?? 120);
          const focusHi = Math.min(sr / 2 - 1, p.voiceFocusHi ?? 3400);
          const lobin   = Math.max(0,       Math.floor(focusLo / binHz));
          const hibin   = Math.min(halfN-1, Math.ceil(focusHi  / binHz));
          const bgAtten = Math.max(0, 1 - (bgSuppress / 100) - (voiceIso / 200));
          for (let f = 0; f < frameCount; f++) {
            for (let k = 0; k < halfN; k++) {
              if (k < lobin || k > hibin) mag[f][k] *= bgAtten;
            }
          }
        }

        // Spectral gate (NR floor) — only when NR is active
        if (nrAmount > 1) {
          DSP.spectralGate(mag, p.nrFloor ?? -72, sr, hopSize);
        }

        // ONE inverse STFT
        const recon = DSP.inverseSTFT(mag, phase, fftSize, hopSize, len);
        // At the first/last fftSize samples the Hann window tapers to zero,
        // so windowSum is tiny and the OLA normalization amplifies any spectral
        // modification into an artifact. Linear fade + safety clamp prevents
        // audible clicks without changing interior audio.
        const fadeLen = Math.min(fftSize, Math.floor(len / 4));
        for (let i = 0; i < fadeLen; i++) {
          const t = i / fadeLen;
          recon[i] *= t;
          if (len - 1 - i >= 0) recon[len - 1 - i] *= t;
        }
        const outCh = resultBuf.getChannelData(ch);
        const copyN = Math.min(recon.length, len);
        for (let i = 0; i < copyN; i++) {
          // Safety clamp: values > ±2 are always artifacts (> +6 dBFS)
          outCh[i] = Math.max(-2, Math.min(2, recon[i]));
        }
      }

      procBuf = resultBuf;
    }

    // ── Stereo width (M/S, applied before dry/wet) ──────────────────────────
    // stereoWidth: 0=mono, 100=original, 200=double-wide
    if (nCh >= 2) {
      const wPct = p.stereoWidth ?? 100;
      if (Math.abs(wPct - 100) > 1) {
        const sideMult = wPct / 100;
        const L = procBuf.getChannelData(0);
        const R = procBuf.getChannelData(1);
        for (let i = 0; i < len; i++) {
          const mid  = (L[i] + R[i]) * 0.5;
          const side = (L[i] - R[i]) * 0.5 * sideMult;
          L[i] = mid + side;
          R[i] = mid - side;
        }
      }
    }

    // ── Dry/wet mix ─────────────────────────────────────────────────────────
    const dryWet = Math.max(0, Math.min(1, (p.dryWet ?? 100) / 100));
    if (dryWet >= 1) return procBuf;

    const mixBuf = (new OfflineAudioContext(nCh, len, sr)).createBuffer(nCh, len, sr);
    for (let ch = 0; ch < nCh; ch++) {
      const dry = audioBuffer.getChannelData(ch);
      const wet = procBuf.getChannelData(ch);
      const out = mixBuf.getChannelData(ch);
      for (let i = 0; i < len; i++) out[i] = dry[i] * (1 - dryWet) + wet[i] * dryWet;
    }
    return mixBuf;
  }

  updateIsolationParams(nextParams) {
    if (!nextParams || typeof nextParams !== 'object') return;
    this._isolationParams = {
      ...this._isolationParams,
      ...nextParams,
    };
    if (this.mlWorker) {
      this.mlWorker.postMessage({
        type: 'setIsolationConfig',
        payload: this._isolationParams,
      });
    }
  }

  // Public getter — used by app.js's offline pipeline so the Speaker
  // Isolation card's Bg Level / Mask Refine / Method controls actually
  // affect output even when the live worklet isn't running.
  getIsolationParams() {
    return { ...this._isolationParams };
  }

  // Forward sound mute state to the ML worker so it can apply identical
  // suppression in the live (worklet) path. Idempotent and safe to call
  // before the worker is ready (re-sent on 'ready').
  updateSoundMutes(soundMutes) {
    if (this.mlWorker) {
      this.mlWorker.postMessage({ type: 'setSoundMutes', payload: soundMutes || {} });
    }
  }

  // ── Bind all 52 sliders ──────────────────────────────────────────────────
  /**
   * Finds every slider built by buildPanels() (id="sl_<paramId>") and
   * attaches an 'input' listener that applies SLIDER_REGISTRY transforms
   * and forwards the full snapshot to the worklet via updateParams().
   * Safe to call before workletNode is created — updateParams() guards itself.
   */
  _bindSliders() {
    if (this._slidersBound) return;
    this._slidersBound = true;
    // DOM sliders use id="sl_gateThresh", id="sl_eqBass", etc.
    const sliders = document.querySelectorAll('input[type="range"][id^="sl_"]');
    const snapshot = {};
    sliders.forEach((s) => {
      const paramId = s.id.slice(3); // strip 'sl_' prefix
      snapshot[paramId] = parseFloat(s.value);
    });
    sliders.forEach((el) => {
      el.addEventListener('input', () => {
        const paramId = el.id.slice(3);
        snapshot[paramId] = parseFloat(el.value);
        if (window._vipApp && window._vipApp.params) {
          window._vipApp.params[paramId] = parseFloat(el.value);
        }
        // Apply transforms (nrAmount, dryWet → 0-1) then forward
        this.updateParams(this._normalizeRawParams(snapshot));
      });
    });
  }

  // ── Bind diarization timeline + isolation control events ─────────────────
  // Idempotent: safe to call before AudioContext/MLWorker exist, and safe
  // to call multiple times (subsequent calls early-return).
  _bindIsolationControls() {
    if (this._isolationBindingsAttached) return;
    this._isolationBindingsAttached = true;
    const _set = (payload) => this.updateIsolationParams(payload);

    // Method select
    const mSel = document.getElementById('isolationMethodSelect');
    mSel?.addEventListener('change', () => _set({ isolationMethod: mSel.value }));

    // Confidence slider
    const cSl = document.getElementById('isolationConfidenceSlider');
    const cOut = document.getElementById('isolationConfidenceReadout');
    const _cPct = () => ((Number(cSl.value) - Number(cSl.min)) / (Number(cSl.max) - Number(cSl.min)) * 100).toFixed(1) + '%';
    if (cSl) cSl.style.setProperty('--pct', _cPct());
    cSl?.addEventListener('input', () => {
      if (cOut) cOut.textContent = cSl.value + '%';
      cSl.style.setProperty('--pct', _cPct());
      _set({ ecapaSimilarityThreshold: Number(cSl.value) / 100 });
    });

    // Background volume slider
    const bgSl = document.getElementById('isolationBgVolumeSlider');
    const bgOut = document.getElementById('isolationBgReadout');
    const _bgPct = () => ((Number(bgSl.value) - Number(bgSl.min)) / (Number(bgSl.max) - Number(bgSl.min)) * 100).toFixed(1) + '%';
    if (bgSl) bgSl.style.setProperty('--pct', _bgPct());
    bgSl?.addEventListener('input', () => {
      if (bgOut) bgOut.textContent = bgSl.value + '%';
      bgSl.style.setProperty('--pct', _bgPct());
      _set({ backgroundVolume: Number(bgSl.value) / 100 });
    });

    // Mask refinement checkbox
    const mRef = document.getElementById('isolationMaskRefine');
    mRef?.addEventListener('change', () => _set({ maskRefinement: mRef.checked }));

    // Zoom controls
    document.getElementById('diarZoomIn') ?.addEventListener('click', () => window._diarZoom?.(2));
    document.getElementById('diarZoomOut')?.addEventListener('click', () => window._diarZoom?.(0.5));
    document.getElementById('diarZoomFit')?.addEventListener('click', () => window._diarZoomFit?.());

    // Voiceprint enroll
    const enrollBtn = document.getElementById('enrollVoiceprintBtn');
    const clearBtn  = document.getElementById('clearVoiceprintBtn');
    const statusEl  = document.getElementById('voiceprintStatus');

    enrollBtn?.addEventListener('click', async () => {
      const app = window._vipApp;
      if (!app?.mediaStream) {
        if (statusEl) { statusEl.textContent = 'Start mic first'; statusEl.style.color = '#f59e0b'; }
        return;
      }
      if (statusEl) { statusEl.textContent = 'Recording 5s…'; statusEl.style.color = '#f59e0b'; }
      enrollBtn.disabled = true;
      try {
        const rec = new MediaRecorder(app.mediaStream, { mimeType: 'audio/webm;codecs=opus' });
        const chunks = [];
        rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        rec.start(100);
        await new Promise(r => setTimeout(r, 5000));
        rec.stop();
        await new Promise(r => { rec.onstop = r; });
        const blob    = new Blob(chunks, { type: 'audio/webm' });
        const arrBuf  = await blob.arrayBuffer();
        const decoded = await this.ctx.decodeAudioData(arrBuf);
        const pcm     = new Float32Array(decoded.getChannelData(0));
        if (this.mlWorker) {
          this.mlWorker.postMessage({ type: 'enrollVoiceprint', payload: { pcm } }, [pcm.buffer]);
        }
      } catch(err) {
        if (statusEl) { statusEl.textContent = 'Error: ' + err.message; statusEl.style.color = '#ef4444'; }
      } finally { enrollBtn.disabled = false; }
    });

    clearBtn?.addEventListener('click', () => this.mlWorker && this.mlWorker.postMessage({ type: 'clearVoiceprint' }));

    const initialParams = {};
    if (mSel?.value) initialParams.isolationMethod = mSel.value;
    if (cSl?.value) initialParams.ecapaSimilarityThreshold = Number(cSl.value) / 100;
    if (bgSl?.value) initialParams.backgroundVolume = Number(bgSl.value) / 100;
    if (mRef) initialParams.maskRefinement = mRef.checked;
    if (Object.keys(initialParams).length > 0) this.updateIsolationParams(initialParams);
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
    if (typeof app.onSlider === 'function') {
      const _origOnSlider = app.onSlider.bind(app);
      app.onSlider = function (...args) {
        _origOnSlider(...args);
        const raw = app.params || window.VIP_PARAMS;
        if (raw) orch.updateParams(orch._normalizeRawParams(raw));
      };
    }

    // ── Patch applyPreset ──────────────────────────────────────────────
    if (typeof app.applyPreset === 'function') {
      const _origApply = app.applyPreset.bind(app);
      app.applyPreset = function (name) {
        _origApply(name);
        const raw = app.params || window.VIP_PARAMS;
        if (raw) orch.updateParams(orch._normalizeRawParams(raw));
      };
    }

    // ── Patch toggleRecording to ensure worklet is ready first ─────────
    if (typeof app.toggleRecording === 'function') {
      const _origToggle = app.toggleRecording.bind(app);
      app.toggleRecording = async function () {
        if (!orch.initialized) {
          try { await orch.init(); } catch (e) { console.warn('[Orchestrator] init during toggleRecording failed:', e); }
        }
        return _origToggle();
      };
    }

    // ── Pre-warm ML Worker immediately ────────────────────────────────
    // Web Workers don't require a user gesture. Starting the ML Worker
    // now restores the eager-load behaviour that previously lived in the
    // VoiceIsolatePro constructor, so models begin loading at page open.
    // AudioContext + AudioWorklet are still deferred to first gesture below.
    orch._initMLWorker().catch(e =>
      console.warn('[Orchestrator] ML worker prewarm error:', e)
    );

    // ── Bind Speaker Isolation card controls eagerly ──────────────────
    // These controls (Method dropdown, Confidence/Bg Level sliders, Mask
    // Refine, Voiceprint, sound mute toggles) only touch DOM and post
    // messages — they don't need the AudioContext or AudioWorklet. Wiring
    // them at bootstrap means user interaction works immediately, and is
    // resilient to AudioContext init failures (e.g. autoplay-blocked).
    const bindIso = () => orch._bindIsolationControls();
    const bindSliders = () => orch._bindSliders();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        bindIso();
        bindSliders();
      }, { once: true });
    } else {
      bindIso();
      bindSliders();
    }

    // ── Pre-warm AudioWorklet modules ─────────────────────────────────
    // A suspended AudioContext can be created without a user gesture;
    // addModule() only requires an AudioContext to exist, not be running.
    // This eliminates 50-200 ms of worklet compile latency on first gesture.
    orch._preWarmWorklet = (async () => {
      try {
        const suspCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        await loadDspProcessorWorklet(suspCtx);
        orch._preWarmedCtx = suspCtx;
        console.info('[Orchestrator] AudioWorklet pre-warmed');
      } catch (e) {
        console.warn('[Orchestrator] Worklet prewarm failed (non-fatal):', e);
      }
    })();

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
