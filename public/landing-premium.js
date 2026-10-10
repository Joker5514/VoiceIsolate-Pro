/**
 * VoiceIsolate-Pro — Premium landing workspace wiring:
 * OnDeviceBadge, SignalCanvas, ComparisonToggle, LiveMeters, profiles, nav state.
 */

'use strict';

import { getAudioSessionStore, SessionEvents } from '/src/state/audioSessionStore.js';
import { getUIStore, NavigationSections } from '/src/state/uiStore.js';
import { createPlatformAdapter } from '/src/platform/index.js';
import { SignalCanvas } from '/src/ui/components/SignalCanvas/SignalCanvas.js';
import { ComparisonToggle } from '/src/ui/components/ComparisonToggle/ComparisonToggle.js';
import { LiveMeters } from '/src/ui/components/LiveMeters/LiveMeters.js';
import { OnDeviceBadge } from '/src/ui/components/OnDeviceBadge/OnDeviceBadge.js';
import { runAutoAnalysis } from '/src/core/audio/analysis/AutoAnalysis.js';
import { createYieldBudget } from '/src/pipeline/ui-yield.js';
import { Profiles, ComparisonModes } from '/src/ui/tokens/design-tokens.js';

function initUnifiedWorkspace() {
  const sessionStore = getAudioSessionStore();
  const uiStore = getUIStore();
  const platform = createPlatformAdapter(null, sessionStore, uiStore);

  // Detect capabilities
  platform.detectCapabilities().then((caps) => {
    sessionStore.setDeviceCapabilities(caps);
    // Update badge
    const badgeMount = document.getElementById('onDeviceBadgeMount');
    if (badgeMount) {
      const badge = new OnDeviceBadge(badgeMount, { backend: caps.webgpu ? 'WebGPU' : 'WASM' });
      badge.setStatus('ready', caps.webgpu ? 'WebGPU' : 'WASM');
      sessionStore.subscribe('ANALYSIS_STARTED', () => {
        badge.setStatus(sessionStore.isAnalyzing() ? 'processing' : 'ready');
      });
    }
  });

  // Unified Signal Canvas
  const canvasHost = document.getElementById('unifiedSignalCanvas');
  let signalCanvas = null;
  if (canvasHost) {
    signalCanvas = new SignalCanvas(canvasHost, { viewMode: 'combined' });
    // Wire to session store
    sessionStore.subscribe((event, payload, state) => {
      if (event === 'SESSION_IMPORTED' && state.source?.rawBuffer) {
        signalCanvas.setAudioData(state.source.rawBuffer, state.source.duration, state.source.sampleRate);
      }
      if (event === 'REGIONS_UPDATED') {
        signalCanvas.setRegions(state.regions);
      }
      if (event === 'REGION_SELECTED' && state.selection) {
        signalCanvas.setSelection(state.selection);
      }
    });

    // Wire selection to action palette (will be mounted by landing.js or here)
    signalCanvas.on('regionSelected', (sel) => {
      sessionStore.selectRegion(sel);
      // Show contextual palette if available
      window.dispatchEvent(new CustomEvent('vip:regionSelected', { detail: sel }));
    });
  }

  // Comparison Toggle
  const compMount = document.getElementById('comparisonToggleMount');
  if (compMount) {
    const toggle = new ComparisonToggle(compMount);
    toggle.on('modeChanged', (mode) => {
      sessionStore.setComparisonMode(mode);
      signalCanvas?.setComparisonMode(mode);
      // Also trigger existing compare buttons for backwards compat
      const map = { raw: 'compareOriginalBtn', processed: 'compareCleanedBtn', removed: 'compareRemovedBtn' };
      const btn = document.getElementById(map[mode]);
      if (btn) {
        document.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        btn.setAttribute('aria-pressed', 'true');
      }
    });
    sessionStore.subscribe('COMPARE_MODE_CHANGED', (mode) => {
      toggle.setMode(mode);
    });
    // A/B toggle
    toggle.on('abToggle', () => {
      const current = sessionStore.getComparisonMode();
      const next = current === ComparisonModes.RAW ? ComparisonModes.PROCESSED : ComparisonModes.RAW;
      sessionStore.setComparisonMode(next);
      toggle.setMode(next);
    });
  }

  // Live Meters
  const metersMount = document.getElementById('liveMetricsMount');
  if (metersMount) {
    const meters = new LiveMeters(metersMount);
    sessionStore.subscribe((event, payload, state) => {
      if (event === 'REGIONS_UPDATED' || event === 'SESSION_IMPORTED') {
        meters.setMetrics({
          voiceClarity: state.metrics.voiceClarity,
          noiseReduction: state.metrics.noiseReduction || state.analysis.snrDb,
          whisperRetention: state.metrics.whisperRetention,
          outputLevelDb: state.metrics.outputLevelDb,
          snrDb: state.analysis.snrDb,
          rms: state.metrics.rms,
          advanced: {
            backend: state.analysis.backend,
            model: 'bsrnn_vocals',
          },
        });
      }
    });
  }

  // Profiles
  const profileBtns = document.querySelectorAll('[data-profile]');
  for (const btn of profileBtns) {
    btn.addEventListener('click', () => {
      const profile = btn.dataset.profile;
      sessionStore.setProfile(profile);
      profileBtns.forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.profile === profile));
        b.classList.toggle('vip-btn--primary', b.dataset.profile === profile);
        b.classList.toggle('vip-btn--ghost', b.dataset.profile !== profile);
      });
      uiStore.showToast?.(`Profile: ${profile}`, 'info');
    });
  }
  sessionStore.subscribe('PROFILE_CHANGED', (profile) => {
    profileBtns.forEach((b) => {
      const active = b.dataset.profile === profile;
      b.setAttribute('aria-pressed', String(active));
      b.classList.toggle('vip-btn--primary', active);
      b.classList.toggle('vip-btn--ghost', !active);
    });
  });

  // Unified nav active state
  const navItems = document.querySelectorAll('[data-nav]');
  const updateNav = () => {
    const active = uiStore.getState().navigation;
    navItems.forEach((el) => {
      const isActive = el.dataset.nav === active;
      el.classList.toggle('vip-unified-nav__item--active', isActive);
      if (isActive) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
  };
  uiStore.subscribe('NAVIGATION_CHANGED', updateNav);
  updateNav();

  // Automatic analysis on import — enhance existing landing.js ingestion
  // Listen for file ingestion via custom event or intercept
  window.addEventListener('vip:fileImported', async (e) => {
    const { channelData, sampleRate, analysis } = e.detail || {};
    if (!channelData) return;
    try {
      let result;
      if (analysis) {
        // landing.js owns this import's analysis and publishes it to the store.
        result = await analysis;
      } else {
        sessionStore.startAnalysis();
        result = await runAutoAnalysis(channelData, sampleRate, {
          maybeYield: createYieldBudget(),
          onProgress: (pct, extra) => {
            sessionStore.updateAnalysisProgress(pct, extra);
          },
        });
        sessionStore.setAnalysisResult({
          ...result,
          regions: result.regions,
          snrDb: result.snrDb,
          speechRatio: result.speechRatio,
        });
      }
      document.getElementById('analysisOverlayStatus').textContent =
        `Analysis ready — ${result.regions.length} regions detected (Speech ${result.speechSegments.length}, Whisper ${result.whisperCandidates.length}, Noise ${result.noiseSegments.length})`;
    } catch (err) {
      if (err?.name === 'AbortError') return; // superseded by a newer import
      console.warn('[Premium] auto analysis failed', err);
      sessionStore.setAnalysisResult({ state: 'error', error: err.message });
    }
  });

  // Raw / Processed / Removed is owned by landing.js (setRaw at import,
  // setProcessed on stems). A second controller here used to poll the mixer
  // and re-clone every stem ~9x in one task (5.6 s on a 5-minute file), then
  // overwrote the store's raw buffer with the processed one.

  // Keyboard shortcuts via platform adapter
  platform.setupKeyboardShortcuts({
    playPause: () => document.getElementById('playBtn')?.click(),
    abToggle: () => document.getElementById('compareOriginalBtn')?.click(),
    clearSelection: () => signalCanvas?.clearSelection(),
    toggleLoop: () => document.getElementById('loopBtn')?.click(),
    cropIn: () => document.getElementById('cropInBtn')?.click(),
    cropOut: () => document.getElementById('cropOutBtn')?.click(),
  });

  console.log('[VIP][Premium] Unified signal-first workspace initialized', { platform: platform.platform });
}

document.addEventListener('DOMContentLoaded', () => {
  initUnifiedWorkspace();
});

// Also init immediately if DOM already loaded
if (document.readyState !== 'loading') {
  initUnifiedWorkspace();
}
