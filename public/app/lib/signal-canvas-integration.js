/**
 * VoiceIsolate Pro — Signal Canvas Integration
 * Bridges premium signal-first session model to existing MLWorker/PlaybackMixer/app.js
 * Issue #820
 * Events: SESSION_IMPORTED, ANALYSIS_STARTED, REGIONS_UPDATED, REGION_SELECTED,
 *         REGION_RESIZED, ACTION_PREVIEWED, PROCESSING_APPLIED, COMPARE_MODE_CHANGED, EXPORT_REQUESTED
 */

import { getAudioSessionStore } from '/src/state/audioSessionStore.js';
import { ComparisonModes } from '/src/ui/tokens/design-tokens.js';

export function createSignalCanvasIntegration({ app, sessionStore, processingController } = {}) {
  const store = sessionStore || getAudioSessionStore();
  const state = {
    bound: false,
  };

  function dispatch(type, detail = {}) {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail }));
    } catch {}
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
    dispatch('REGIONS_UPDATED', { regions: store.getState?.().analysis?.regions || [] });
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
    store.subscribe?.((s, prev) => {
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
      if (s.analysis?.regions !== prev?.analysis?.regions) {
        dispatch('REGIONS_UPDATED', { regions: s.analysis?.regions || [] });
      if (s.regions !== prev?.regions) {
        dispatch('REGIONS_UPDATED', { regions: s.regions || [] });
      }
    });

    // Expose helpers for contextual palette
    window.__vipEngineerProcessSelection = window.__vipEngineerProcessSelection || (({ action, startSec, endSec, startNorm, endNorm }) => {
      // Map contextual actions to existing app controls
      const appInstance = window._vipApp || app;
      if (!appInstance) return;
      // Store selection for later
      appInstance._protectRegions = appInstance._protectRegions || [];
      appInstance._suppressRegions = appInstance._suppressRegions || [];
      // For Isolate: set protect region
      if (action === 'isolate') {
        appInstance._protectRegions = [{ start: startSec, end: endSec, confidence: 0.9 }];
        appInstance.runPipeline?.();
        dispatch('ACTION_PREVIEWED', { action, startSec, endSec });
      } else if (action === 'enhance' || action === 'boost-whisper') {
        // Boost whisper: set whisperLift + voiceTunnel
        if (appInstance.params) {
          appInstance.params.whisperLift = action === 'boost-whisper' ? 12 : 6;
          appInstance.params.voiceTunnel = 60;
        }
        dispatch('ACTION_PREVIEWED', { action, startSec, endSec });
      } else if (action === 'reduce-noise') {
        if (appInstance.params) {
          appInstance.params.nrAmount = 70;
          appInstance.params.bgSuppress = 60;
        }
        dispatch('ACTION_PREVIEWED', { action, startSec, endSec });
      } else if (action === 'preview') {
        dispatch('ACTION_PREVIEWED', { action, startSec, endSec });
      }
    });

    window.__vipSetComparisonMode = window.__vipSetComparisonMode || ((mode) => {
      const appInstance = window._vipApp || app;
      if (!appInstance) return;
      if (mode === ComparisonModes.RAW || mode === 'raw') {
        if (appInstance.abMode !== 'original') appInstance.toggleAB?.();
      } else if (mode === ComparisonModes.PROCESSED || mode === 'processed') {
        if (appInstance.abMode !== 'processed') appInstance.toggleAB?.();
      } else if (mode === ComparisonModes.REMOVED || mode === 'removed') {
        // Removed audition: load noise stem if available
        const noise = appInstance.noiseBuffer || null;
        if (noise) {
          const prev = appInstance._bridgeBuf;
          appInstance._bridgeBuf = null;
          appInstance.buildLiveChain?.(noise).then(() => {
            appInstance._bridgeBuf = prev;
          });
        }
      }
      dispatch('COMPARE_MODE_CHANGED', { mode });
    });

    window.__vipApplyProfile = window.__vipApplyProfile || ((profile) => {
      const appInstance = window._vipApp || app;
      if (!appInstance) return;
      const presets = { quick: 'Voice Clarity', meeting: 'Meeting', studio: 'Studio', forensic: 'Forensic Extract' };
      const presetName = presets[profile] || 'Voice Clarity';
      appInstance.applyPreset?.(presetName);
    });

    console.log('[VIP][signal-canvas-integration] bound — unified events SESSION_IMPORTED etc');
  }

  return { bind, dispatch };
}

// Auto-bind if imported as side-effect
try {
  const integration = createSignalCanvasIntegration();
  integration.bind();
  window.__vipSignalCanvasIntegration = integration;
} catch (e) {
  console.warn('[VIP][signal-canvas] auto-bind failed', e);
}
