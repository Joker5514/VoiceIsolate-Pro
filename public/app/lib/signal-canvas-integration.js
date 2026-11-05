/**
 * VoiceIsolate Pro — Signal Canvas Integration
 * Bridges premium signal-first session model to existing MLWorker/PlaybackMixer/app.js
 * Issue #820
 * Events: SESSION_IMPORTED, ANALYSIS_STARTED, REGIONS_UPDATED, REGION_SELECTED,
 *         REGION_RESIZED, ACTION_PREVIEWED, PROCESSING_APPLIED, COMPARE_MODE_CHANGED, EXPORT_REQUESTED
 */

import { getAudioSessionStore } from '/src/state/audioSessionStore.js';
import { ComparisonModes } from '/src/ui/tokens/design-tokens.js';
import {
  ENGINEER_ACTIONS,
  validateSelectionBounds,
  resolveActionParameterPlan,
} from '/src/core/EngineerActionContract.js';

export function createSignalCanvasIntegration({ app, sessionStore, processingController } = {}) {
  const store = sessionStore || getAudioSessionStore();
  const state = {
    bound: false,
    selectionStopTimer: null,
  };

  function clearSelectionPreviewTimer() {
    if (state.selectionStopTimer) {
      clearTimeout(state.selectionStopTimer);
      state.selectionStopTimer = null;
    }
  }

  function dispatch(type, detail = {}) {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail }));
    } catch {}
  }

  // Duration resolution for selection bounds: the transport clock wins when
  // it knows a duration, but a present-yet-zero transport value must NOT
  // short-circuit the fallbacks — before any decode it is 0 while the
  // session store already holds the imported duration. The store keeps its
  // duration under transport.duration (importSource), not top-level duration.
  function resolveDuration(appInstance) {
    const transport = typeof appInstance._getTransportDuration === 'function'
      ? appInstance._getTransportDuration()
      : 0;
    if (Number.isFinite(transport) && transport > 0) return transport;
    const buf = (appInstance.outputBuffer || appInstance.inputBuffer || appInstance.origBuffer)?.duration || 0;
    if (buf > 0) return buf;
    const session = store.getState?.();
    return session?.transport?.duration || session?.duration || 0;
  }

  function handleFileImported(e) {
    const d = e.detail || {};
    const channelData = d.channelData || [];
    const sampleRate = d.sampleRate || 48000;
    const duration = d.duration || (channelData[0]?.length / sampleRate) || 0;

    // Canonical session model import
    store.importSource?.({
      file: d.file || null,
      name: d.name || d.file?.name || 'audio',
      channelData,
      sampleRate,
      duration,
    });

    dispatch('SESSION_IMPORTED', { channelData, sampleRate, duration, file: d.file });
    dispatch('ANALYSIS_STARTED', { channelData, sampleRate });

    // Update premium workspace if present
    window.__vipPremiumWorkspace?.handleFileImported?.(d);
  }

  function handleProcessed(e) {
    const d = e.detail || {};
    const cleanChannels = d.cleanChannels || [];
    const noiseChannels = d.noiseChannels || null;

    if (cleanChannels.length && processingController) {
      // Build AudioBuffer-like processed
      try {
        const sr = d.sampleRate || 48000;
        // For session store, create Float32Array buffers
        const processedBuffer = { channelData: cleanChannels, sampleRate: sr };
        const removedBuffer = noiseChannels ? { channelData: noiseChannels, sampleRate: sr } : null;
        processingController.setProcessed?.(processedBuffer, removedBuffer);
        store.applyProcessing?.({
          processedBuffer,
          removedBuffer,
          metrics: d.metrics || null,
        });
      } catch (err) {
        console.warn('[VIP][signal-canvas] setProcessed failed', err);
      }
    }

    dispatch('PROCESSING_APPLIED', {
      cleanChannels,
      noiseChannels,
      outputBuffer: d.outputBuffer,
    });
    dispatch('REGIONS_UPDATED', { regions: store.getState?.().regions || [] });
  }

  function handleSelectionFromStore() {
    const s = store.getState?.();
    if (!s) return;
    const sel = s.selection || s.selectedRegion || null;
    if (sel) {
      dispatch('REGION_SELECTED', sel);
    }
  }

  function bind() {
    if (state.bound) return;
    state.bound = true;

    window.addEventListener('vip:fileImported', handleFileImported);
    window.addEventListener('vip:engineerFileImported', handleFileImported);
    window.addEventListener('vip:processed', handleProcessed);
    window.addEventListener('vip:processingDone', (e) => {
      // Bridge to processed if cleanChannels not yet dispatched
      if (!e.detail?.cleanChannels && app?.outputBuffer) {
        handleProcessed({
          detail: {
            cleanChannels: app._cleanStemChannels || [app.outputBuffer.getChannelData(0)],
            noiseChannels: app._noiseStemChannels || null,
            sampleRate: app._stemSampleRate || app.outputBuffer.sampleRate,
            outputBuffer: app.outputBuffer,
          }
        });
      }
    });

    // Session store → events
    // Global subscribers receive (event, payload, state) — see audioSessionStore._emit
    let prevSession = store.getState?.();
    store.subscribe?.((event, payload, s) => {
      const prev = prevSession;
      prevSession = s;
      if (s.selection !== prev?.selection) {
        handleSelectionFromStore();
      }
      if (s.comparisonMode !== prev?.comparisonMode) {
        dispatch('COMPARE_MODE_CHANGED', { mode: s.comparisonMode });
      }
      if (s.regions !== prev?.regions) {
        dispatch('REGIONS_UPDATED', { regions: s.regions || [] });
      }
    });

    async function playSelection(startSec, endSec) {
      const appInstance = window._vipApp || app;
      if (!appInstance) return { ok: false, reason: 'Engineer workspace not ready.' };

      clearSelectionPreviewTimer();
      try {
        if (!appInstance.origBuffer && !appInstance.inputBuffer && typeof appInstance.ensureDecoded === 'function') {
          await appInstance.ensureDecoded();
        }
      } catch (err) {
        const msg = err?.message || 'Unable to decode audio for selection preview.';
        appInstance.showNotification?.(msg, 'error');
        return { ok: false, reason: msg };
      }

      const dur = resolveDuration(appInstance);
      const bounds = validateSelectionBounds(startSec, endSec, dur);
      if (!bounds.ok) {
        appInstance.showNotification?.(bounds.reason || 'Invalid selection bounds.', 'warn');
        return bounds;
      }

      try {
        appInstance.ensureCtx?.();
        if (appInstance.ctx && appInstance.ctx.state === 'suspended') {
          await appInstance.ctx.resume();
        }
        if (appInstance.isPlaying) {
          appInstance.pause?.();
        }
        appInstance.seekTo?.(bounds.startNorm);
        appInstance.play?.();

        const speedInput = appInstance.dom?.tpSpeed;
        const speed = Math.max(0.25, Number(speedInput?.value) || 1);
        const playMs = Math.max(25, ((bounds.endSec - bounds.startSec) / speed) * 1000);
        state.selectionStopTimer = setTimeout(() => {
          state.selectionStopTimer = null;
          if (appInstance.isPlaying) {
            appInstance.pause?.();
            appInstance.seekTo?.(bounds.startNorm);
          }
        }, playMs);

        appInstance._provenance?.recordOperation({
          id: 'region-preview',
          status: 'completed',
          detail: `${bounds.startSec.toFixed(2)}s -> ${bounds.endSec.toFixed(2)}s`,
        });
        appInstance.showNotification?.(
          `Previewing selection ${bounds.startSec.toFixed(2)}s – ${bounds.endSec.toFixed(2)}s`,
          'info',
        );
        dispatch('ACTION_PREVIEWED', {
          action: ENGINEER_ACTIONS.PREVIEW,
          startSec: bounds.startSec,
          endSec: bounds.endSec,
        });
        return { ok: true, ...bounds };
      } catch (err) {
        const msg = err?.message || 'Selection preview failed.';
        appInstance.showNotification?.(msg, 'error');
        return { ok: false, reason: msg };
      }
    }

    window.__vipStopSelectionPreview = clearSelectionPreviewTimer;
    window.__vipPlaySelection = (startSec, endSec) => playSelection(startSec, endSec);

    // Expose helpers for contextual palette
    window.__vipEngineerProcessSelection = ({ action: rawAction, startSec, endSec, startNorm, endNorm }) => {
      const appInstance = window._vipApp || app;
      if (!appInstance) return { ok: false, reason: 'Engineer workspace not ready.' };

      const notify = (msg, level = 'info') => appInstance.showNotification?.(msg, level);
      const plan = resolveActionParameterPlan(rawAction);
      if (!plan.supported || !plan.action) {
        notify(plan.scopeNote, 'warn');
        return { ok: false, reason: plan.scopeNote };
      }
      const action = plan.action;

      const dur = resolveDuration(appInstance);
      const resolvedStart = Number.isFinite(Number(startSec))
        ? Number(startSec)
        : Number(startNorm || 0) * dur;
      const resolvedEnd = Number.isFinite(Number(endSec))
        ? Number(endSec)
        : Number(endNorm || 0) * dur;
      const bounds = validateSelectionBounds(resolvedStart, resolvedEnd, dur);
      if (!bounds.ok) {
        notify(bounds.reason || 'Invalid selection bounds.', 'warn');
        return { ok: false, reason: bounds.reason };
      }

      appInstance._protectRegions = appInstance._protectRegions || [];
      appInstance._suppressRegions = appInstance._suppressRegions || [];

      const setControls = (values) => {
        const locked = Object.keys(values).filter((id) => appInstance._isSliderLocked?.(id));
        const applied = {};
        for (const [id, v] of Object.entries(values)) {
          if (!locked.includes(id)) {
            appInstance._setSliderUi?.(id, v);
            applied[id] = v;
          }
        }
        appInstance._syncBridgeParams?.();
        return { locked, applied };
      };
      const lockNote = (locked) => (locked.length ? ` Locked, left unchanged: ${locked.join(', ')}.` : '');
      const mlStemsCurrent = appInstance._mlIsolationSucceeded
        && appInstance._stemFileSeq != null
        && appInstance._stemFileSeq === appInstance._fileSeq;

      if (action === ENGINEER_ACTIONS.PREVIEW) {
        void playSelection(bounds.startSec, bounds.endSec);
        return { ok: true, action, startSec: bounds.startSec, endSec: bounds.endSec };
      }

      if (action === ENGINEER_ACTIONS.ISOLATE) {
        appInstance._protectRegions = [{ start: bounds.startSec, end: bounds.endSec, confidence: 0.9 }];
        if (mlStemsCurrent) {
          notify('Selection isolate applies to the DSP fallback only; ML stems are file-wide. Use Background and Voice to rebalance.');
        } else {
          appInstance.runPipeline?.();
        }
        appInstance._provenance?.recordOperation({
          id: 'region-isolate',
          status: 'completed',
          detail: `${bounds.startSec.toFixed(2)}s -> ${bounds.endSec.toFixed(2)}s`,
        });
        dispatch('ACTION_PREVIEWED', { action, startSec: bounds.startSec, endSec: bounds.endSec });
        return { ok: true, action, startSec: bounds.startSec, endSec: bounds.endSec };
      }

      if (
        action === ENGINEER_ACTIONS.ENHANCE
        || action === ENGINEER_ACTIONS.BOOST_WHISPER
        || action === ENGINEER_ACTIONS.REDUCE_NOISE
      ) {
        const { locked, applied } = setControls(plan.params);
        notify(`${plan.scopeNote}${lockNote(locked)}`);
        appInstance._provenance?.recordOperation({
          id: `region-${action}`,
          status: 'completed',
          detail: `${bounds.startSec.toFixed(2)}s -> ${bounds.endSec.toFixed(2)}s (${JSON.stringify(applied)})`,
        });
        dispatch('ACTION_PREVIEWED', {
          action,
          startSec: bounds.startSec,
          endSec: bounds.endSec,
          applied,
          locked,
        });
        return { ok: true, action, startSec: bounds.startSec, endSec: bounds.endSec, applied, locked };
      }

      return { ok: false, reason: `Unhandled action: ${action}` };
    };

    window.__vipSetComparisonMode = (mode) => {
      const appInstance = window._vipApp || app;
      if (!appInstance) return false;
      const bridge = appInstance._bridge;

      if (mode === ComparisonModes.RAW || mode === 'raw' || mode === 'original') {
        if (bridge?.setComparisonMode?.('original')) {
          appInstance.abMode = 'original';
        } else if (appInstance.abMode !== 'original') {
          appInstance.toggleAB?.();
        }
        dispatch('COMPARE_MODE_CHANGED', { mode: 'raw' });
        return true;
      }

      if (mode === ComparisonModes.PROCESSED || mode === 'processed') {
        if (bridge?.setComparisonMode?.('processed')) {
          appInstance.abMode = 'processed';
        } else if (appInstance.abMode !== 'processed') {
          appInstance.toggleAB?.();
        }
        dispatch('COMPARE_MODE_CHANGED', { mode: 'processed' });
        return true;
      }

      if (mode === ComparisonModes.REMOVED || mode === 'removed') {
        if (bridge?.setComparisonMode?.('removed')) {
          dispatch('COMPARE_MODE_CHANGED', { mode: 'removed' });
          return true;
        }
        const noise = appInstance.noiseBuffer || null;
        if (!noise) {
          appInstance.showNotification?.(
            'Run Process first to generate the Removed (Delta) stem.',
            'info',
          );
          return false;
        }
        const prev = appInstance._bridgeBuf;
        appInstance._bridgeBuf = null;
        Promise.resolve(appInstance.buildLiveChain?.(noise)).then(() => {
          appInstance._bridgeBuf = prev;
        });
        dispatch('COMPARE_MODE_CHANGED', { mode: 'removed' });
        return true;
      }
      return false;
    };

    window.__vipApplyProfile = (profile) => {
      const appInstance = window._vipApp || app;
      if (!appInstance) return;
      // Values must be real PRESETS keys: applyPreset() ignores unknown names.
      const presets = { quick: 'Voice Clarity', meeting: 'Room Echo Reduction', studio: 'Podcast Clean', forensic: 'Forensic Extract' };
      const presetName = presets[profile] || 'Voice Clarity';
      appInstance.applyPreset?.(presetName);
      appInstance._provenance?.recordOperation({
        id: 'profile-select',
        status: 'completed',
        detail: `${profile} -> ${presetName}`,
      });
    };

    console.log('[VIP][signal-canvas-integration] bound — unified events SESSION_IMPORTED etc');
  }

  return { bind, dispatch, clearSelectionPreviewTimer };
}

// Auto-bind if imported as side-effect in a browser window
if (typeof window !== 'undefined') {
  try {
    const integration = createSignalCanvasIntegration();
    integration.bind();
    window.__vipSignalCanvasIntegration = integration;
  } catch (e) {
    console.warn('[VIP][signal-canvas] auto-bind failed', e);
  }
}
