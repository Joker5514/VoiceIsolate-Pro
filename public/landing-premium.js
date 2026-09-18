/**
 * VoiceIsolate-Pro — Premium Landing Interactive Demo
 * Implements Issue §2: interactive product demonstration
 * 1. Display waveform/signal.
 * 2. User drags over a region.
 * 3. Region highlights visually.
 * 4. Context action appears: Isolate This.
 * 5. Show immediate before/after feedback.
 *
 * Also wires unified navigation, OnDeviceBadge, SignalCanvas, ComparisonToggle, LiveMeters, profiles
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
import { ProcessingController } from '/src/core/audio/processing/ProcessingController.js';
import { Profiles, ComparisonModes } from '/src/ui/tokens/design-tokens.js';

const $ = (id) => document.getElementById(id);

function initDemoCanvas() {
  const waveEl = $('demoWaveform');
  const waveCanvas = $('demoWaveCanvas');
  const specCanvas = $('demoSpecCanvas');
  const regionEl = $('demoRegion');
  const isolateBtn = $('demoIsolateBtn');
  const beforeAfter = $('demoBeforeAfter');
  const beforeCanvas = $('demoBeforeCanvas');
  const afterCanvas = $('demoAfterCanvas');

  if (!waveEl || !waveCanvas) return;

  const ctx = waveCanvas.getContext('2d');
  const bCtx = beforeCanvas?.getContext('2d');
  const aCtx = afterCanvas?.getContext('2d');
  const sCtx = specCanvas?.getContext('2d');

  // Generate demo waveform data (synthetic)
  const width = waveCanvas.width;
  const height = waveCanvas.height;
  const samples = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    // Simulate voice + noise
    const t = i / width;
    const voice = Math.sin(t * Math.PI * 40) * 0.5 * Math.exp(-Math.pow((t - 0.5) * 3, 2));
    const noise = (Math.random() - 0.5) * 0.15;
    const whisper = t > 0.6 && t < 0.75 ? Math.sin(t * 200) * 0.08 : 0;
    samples[i] = voice + noise + whisper;
  }

  function drawWaveform(targetCtx, w, h, data, color = '#2ed5e5', highlight = null) {
    if (!targetCtx) return;
    targetCtx.fillStyle = '#05080c';
    targetCtx.fillRect(0, 0, w, h);
    const mid = h / 2;
    const scale = h * 0.4;

    // Grid
    targetCtx.strokeStyle = 'rgba(255,255,255,0.04)';
    targetCtx.lineWidth = 0.5;
    for (let i = 1; i < 8; i++) {
      const x = (w / 8) * i;
      targetCtx.beginPath();
      targetCtx.moveTo(x, 0);
      targetCtx.lineTo(x, h);
      targetCtx.stroke();
    }

    // Waveform
    targetCtx.strokeStyle = color;
    targetCtx.lineWidth = 1.5;
    targetCtx.beginPath();
    for (let x = 0; x < w; x++) {
      const y = mid - data[x % data.length] * scale;
      if (x === 0) targetCtx.moveTo(x, y);
      else targetCtx.lineTo(x, y);
    }
    targetCtx.stroke();

    // Highlight region
    if (highlight) {
      const left = Math.floor(highlight.start * w);
      const right = Math.floor(highlight.end * w);
      targetCtx.fillStyle = 'rgba(155,108,255,0.14)';
      targetCtx.fillRect(left, 0, right - left, h);
      targetCtx.strokeStyle = '#9b6cff';
      targetCtx.lineWidth = 2;
      targetCtx.strokeRect(left, 0, right - left, h);
    }

    // Center line
    targetCtx.strokeStyle = '#1d2a34';
    targetCtx.lineWidth = 0.5;
    targetCtx.beginPath();
    targetCtx.moveTo(0, mid);
    targetCtx.lineTo(w, mid);
    targetCtx.stroke();
  }

  function drawSpectrogram() {
    if (!sCtx) return;
    const w = specCanvas.width;
    const h = specCanvas.height;
    sCtx.fillStyle = '#05080c';
    sCtx.fillRect(0, 0, w, h);
    // Fake spectrogram
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        const t = x / w;
        const f = 1 - y / h;
        let intensity = 0.1 + Math.random() * 0.1;
        // Speech formants
        if (t > 0.2 && t < 0.8) {
          const speech = Math.exp(-Math.pow((f - 0.3) * 3, 2)) * 0.6;
          intensity += speech;
        }
        // Whisper high-freq
        if (t > 0.6 && t < 0.75 && f > 0.6) intensity += 0.3;
        // Noise floor
        intensity += 0.05;

        const clamped = Math.min(1, Math.max(0, intensity));
        let r, g, b;
        if (clamped < 0.25) {
          r = 10; g = 14; b = 20;
        } else if (clamped < 0.5) {
          r = 26 + clamped * 100; g = 42; b = 58;
        } else if (clamped < 0.75) {
          r = 194; g = 65; b = 12;
        } else {
          r = 251; g = 191; b = 36;
        }
        sCtx.fillStyle = `rgb(${r},${g},${b})`;
        sCtx.fillRect(x, y, 1, 1);
      }
    }
  }

  drawWaveform(ctx, width, height, samples);
  drawSpectrogram();
  if (bCtx && aCtx) {
    drawWaveform(bCtx, beforeCanvas.width, beforeCanvas.height, samples, '#8d9aaa');
  }

  let isDragging = false;
  let startX = 0;
  let currentRegion = null;

  const getNormX = (clientX) => {
    const rect = waveEl.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const updateRegionDOM = () => {
    if (!currentRegion) {
      regionEl.classList.remove('vip-demo-region--active');
      isolateBtn.classList.remove('vip-demo-action--visible');
      return;
    }
    const left = currentRegion.start * 100;
    const w = (currentRegion.end - currentRegion.start) * 100;
    regionEl.style.left = `${left}%`;
    regionEl.style.width = `${w}%`;
    regionEl.classList.add('vip-demo-region--active');
    isolateBtn.classList.add('vip-demo-action--visible');
  };

  waveEl.addEventListener('pointerdown', (e) => {
    isDragging = true;
    startX = getNormX(e.clientX);
    currentRegion = { start: startX, end: startX };
    waveEl.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  window.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const curX = getNormX(e.clientX);
    currentRegion.start = Math.min(startX, curX);
    currentRegion.end = Math.max(startX, curX);
    drawWaveform(ctx, width, height, samples, '#2ed5e5', currentRegion);
    updateRegionDOM();
  });

  window.addEventListener('pointerup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    if (currentRegion && currentRegion.end - currentRegion.start < 0.02) {
      currentRegion = null;
      drawWaveform(ctx, width, height, samples);
      updateRegionDOM();
      return;
    }
    // Show before/after
    if (beforeAfter && currentRegion) {
      beforeAfter.hidden = false;
      // Simulate isolated result: boost selected region
      const isolated = new Float32Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        const t = i / samples.length;
        if (t >= currentRegion.start && t <= currentRegion.end) {
          isolated[i] = samples[i] * 1.8;
        } else {
          isolated[i] = samples[i] * 0.15;
        }
      }
      drawWaveform(aCtx, afterCanvas.width, afterCanvas.height, isolated, '#9b6cff');
    }
  });

  isolateBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Animate isolation
    isolateBtn.textContent = 'Isolating…';
    setTimeout(() => {
      isolateBtn.textContent = '✓ Isolated';
      isolateBtn.style.background = '#31cf7d';
      setTimeout(() => {
        isolateBtn.textContent = 'Isolate This';
        isolateBtn.style.background = '#9b6cff';
      }, 1500);
    }, 600);
  });

  // Spectrogram rect selection (simplified)
  const specEl = $('demoSpectrogram');
  if (specEl) {
    let specDragging = false;
    let specStart = null;
    let specRegion = null;
    specEl.addEventListener('pointerdown', (e) => {
      specDragging = true;
      const rect = specEl.getBoundingClientRect();
      specStart = {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      };
      specEl.setPointerCapture(e.pointerId);
    });
    window.addEventListener('pointermove', (e) => {
      if (!specDragging || !specStart) return;
      const rect = specEl.getBoundingClientRect();
      const cur = {
        x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
        y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
      };
      // Visual feedback via overlay div (create on fly)
      let overlay = specEl.querySelector('.vip-spec-select');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'vip-spec-select';
        overlay.style.cssText = 'position:absolute; border:2px solid #9b6cff; background:rgba(155,108,255,0.14); pointer-events:none; border-radius:4px;';
        specEl.style.position = 'relative';
        specEl.appendChild(overlay);
      }
      const left = Math.min(specStart.x, cur.x) * 100;
      const top = Math.min(specStart.y, cur.y) * 100;
      const w = Math.abs(cur.x - specStart.x) * 100;
      const h = Math.abs(cur.y - specStart.y) * 100;
      overlay.style.left = `${left}%`;
      overlay.style.top = `${top}%`;
      overlay.style.width = `${w}%`;
      overlay.style.height = `${h}%`;
    });
    window.addEventListener('pointerup', () => {
      specDragging = false;
      specStart = null;
    });
  }
}

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
    const { channelData, sampleRate, duration } = e.detail || {};
    if (!channelData) return;
    try {
      sessionStore.startAnalysis();
      const result = await runAutoAnalysis(channelData, sampleRate, {
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
      document.getElementById('analysisOverlayStatus').textContent =
        `Analysis ready — ${result.regions.length} regions detected (Speech ${result.speechSegments.length}, Whisper ${result.whisperCandidates.length}, Noise ${result.noiseSegments.length})`;
    } catch (err) {
      console.warn('[Premium] auto analysis failed', err);
      sessionStore.setAnalysisResult({ state: 'error', error: err.message });
    }
  });

  // Raw / Processed / Removed handling
  const processingController = new ProcessingController(sessionStore);
  window.__vipProcessingController = processingController;

  // Hook into existing mixer if available
  const checkMixer = setInterval(() => {
    const mixer = window.__vipDiagnostics?.mixer || window.mixer;
    if (mixer?.cleanBuffer) {
      clearInterval(checkMixer);
      // When processed ready, set in controller
      const cleanChannels = [];
      for (let c = 0; c < mixer.cleanBuffer.numberOfChannels; c++) {
        cleanChannels.push(mixer.cleanBuffer.getChannelData(c).slice());
      }
      processingController.setProcessed(cleanChannels, mixer.cleanBuffer.sampleRate);
    }
  }, 1000);

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
  initDemoCanvas();
  initUnifiedWorkspace();
});

// Also init immediately if DOM already loaded
if (document.readyState !== 'loading') {
  initDemoCanvas();
  initUnifiedWorkspace();
}
