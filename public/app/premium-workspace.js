/**
 * VoiceIsolate Pro — Premium Signal-First Workspace (Engineer)
 * Implements Issue #820 unified UX for Browser/Android/Desktop
 * - Signal Canvas is center (waveform + spectrogram + overlays)
 * - Direct selection: waveform horizontal drag, spectrogram rectangle
 * - Contextual palette: Isolate, Enhance Voice, Reduce Noise, Boost Whisper, Preview
 * - Profiles: Quick, Meeting, Studio, Forensic
 * - Raw/Processed/Removed comparison
 * - Live metrics: Voice Clarity, Noise Reduction, Whisper Retention, Output dBFS
 * - 44-48dp touch targets, keyboard shortcuts, high contrast, reduced-motion
 */

import { getAudioSessionStore } from '/src/state/audioSessionStore.js';
import { getUIStore } from '/src/state/uiStore.js';
import { createPlatformAdapter } from '/src/platform/index.js';
import { ComparisonModes, Profiles } from '/src/ui/tokens/design-tokens.js';
import { runAutoAnalysis } from '/src/core/audio/analysis/AutoAnalysis.js';
import { ProcessingController } from '/src/core/audio/processing/ProcessingController.js';

const $ = (id) => document.getElementById(id);

const sessionStore = getAudioSessionStore();
const uiStore = getUIStore();
const platform = createPlatformAdapter();

const state = {
  channelData: null,
  sampleRate: 48000,
  duration: 0,
  selection: null, // { start: 0..1, end: 0..1 }
  isDragging: false,
  dragStart: 0,
  spectrogramDrag: null, // { x0,y0,x1,y1 }
};

// ── Waveform / Spectrogram rendering (decoupled, no alloc in loop) ────────
function drawWaveform(canvas, data) {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0d131b';
  ctx.fillRect(0, 0, w, h);

  if (!data || !data.length) {
    ctx.fillStyle = '#1d2a34';
    ctx.fillRect(0, h / 2 - 1, w, 2);
    return;
  }

  // Decimate for performance: one min/max per pixel column
  const channel = data[0];
  const samplesPerPx = Math.max(1, Math.floor(channel.length / w));
  const mid = h / 2;

  ctx.strokeStyle = '#2ed5e5';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const start = x * samplesPerPx;
    const end = Math.min(channel.length, start + samplesPerPx);
    let min = 1, max = -1;
    for (let i = start; i < end; i++) {
      const v = channel[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const yMin = mid + min * mid * 0.9;
    const yMax = mid + max * mid * 0.9;
    if (x === 0) ctx.moveTo(x, yMin);
    else ctx.lineTo(x, yMin);
  }
  for (let x = w - 1; x >= 0; x--) {
    const start = x * samplesPerPx;
    const end = Math.min(channel.length, start + samplesPerPx);
    let min = 1, max = -1;
    for (let i = start; i < end; i++) {
      const v = channel[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const yMax = mid + max * mid * 0.9;
    ctx.lineTo(x, yMax);
  }
  ctx.closePath();
  ctx.fillStyle = 'rgba(46,213,229,0.18)';
  ctx.fill();
  ctx.stroke();

  // Selection overlay
  if (state.selection) {
    const x0 = Math.floor(state.selection.start * w);
    const x1 = Math.floor(state.selection.end * w);
    ctx.fillStyle = 'rgba(155,108,255,0.14)';
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
    ctx.strokeStyle = '#9b6cff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, 0, Math.max(2, x1 - x0), h);
    // Handles
    ctx.fillStyle = '#9b6cff';
    ctx.fillRect(x0 - 3, 0, 6, h);
    ctx.fillRect(x1 - 3, 0, 6, h);
  }

  // Analysis regions overlay (speech/whisper/noise/hum)
  const analysis = sessionStore.getState().analysis;
  if (analysis && analysis.regions) {
    for (const r of analysis.regions) {
      const x0 = Math.floor((r.start / state.duration) * w);
      const x1 = Math.floor((r.end / state.duration) * w);
      let color = 'rgba(46,213,229,0.08)';
      if (r.type === 'whisper') color = 'rgba(155,108,255,0.10)';
      else if (r.type === 'noise' || r.type === 'background_noise') color = 'rgba(139,154,168,0.08)';
      else if (r.type === 'hum') color = 'rgba(255,185,72,0.10)';
      else if (r.type === 'music') color = 'rgba(255,90,122,0.08)';
      ctx.fillStyle = color;
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      // Confidence indicator top bar
      if (r.confidence != null) {
        const barH = 3;
        ctx.fillStyle = r.confidence > 0.7 ? '#31cf7d' : r.confidence > 0.4 ? '#ffb948' : '#ff5a7a';
        ctx.globalAlpha = 0.6 + r.confidence * 0.4;
        ctx.fillRect(x0, 0, Math.max(1, (x1 - x0) * r.confidence), barH);
        ctx.globalAlpha = 1;
      }
    }
  }
}

function drawSpectrogram(canvas) {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0a0f16';
  ctx.fillRect(0, 0, w, h);

  // Fake spectrogram for demo — real would be from analysis
  if (!state.channelData) {
    ctx.fillStyle = '#121a23';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1d2a34';
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillText('Import audio to see spectrogram · 100% on-device', 12, h / 2);
    return;
  }

  // Simple gradient noise + voice band
  const imageData = ctx.createImageData(w, h);
  const data = imageData.data;
  for (let y = 0; y < h; y++) {
    const freqNorm = 1 - y / h; // low at bottom, high at top
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      // Voice energy in mid frequencies
      const voice = Math.exp(-Math.pow(freqNorm - 0.5, 2) / 0.08) * 0.8;
      const noise = Math.random() * 0.15;
      const intensity = Math.min(1, voice + noise);
      // Map to graphite/navy -> cyan
      const r = Math.floor(10 + intensity * 20 + freqNorm * 10);
      const g = Math.floor(15 + intensity * 60 + freqNorm * 20);
      const b = Math.floor(22 + intensity * 120);
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);

  // Spectrogram rectangle selection
  if (state.spectrogramDrag) {
    const { x0, y0, x1, y1 } = state.spectrogramDrag;
    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const width = Math.abs(x1 - x0);
    const height = Math.abs(y1 - y0);
    ctx.fillStyle = 'rgba(155,108,255,0.18)';
    ctx.fillRect(left, top, width, height);
    ctx.strokeStyle = '#9b6cff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(left, top, width, height);
  }

  // Selection vertical overlay (linked to waveform selection)
  if (state.selection) {
    const x0 = Math.floor(state.selection.start * w);
    const x1 = Math.floor(state.selection.end * w);
    ctx.fillStyle = 'rgba(155,108,255,0.12)';
    ctx.fillRect(x0, 0, Math.max(2, x1 - x0), h);
  }
}

// ── Selection handling (pointer events, <100ms feedback) ──────────────────
function getNormX(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  return Math.max(0, Math.min(1, x));
}

function updateSelectionInfo() {
  const el = $('selectionInfo');
  if (!el) return;
  if (!state.selection) {
    el.textContent = 'Drag on waveform to select · drag rectangle on spectrogram · handles to resize · timestamp shown';
    return;
  }
  const startSec = state.selection.start * state.duration;
  const endSec = state.selection.end * state.duration;
  const dur = endSec - startSec;
  const fmt = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
  };
  el.textContent = `${fmt(startSec)} → ${fmt(endSec)} · ${dur.toFixed(2)}s selected · Raw immutable`;
}

function showContextPalette(x, y) {
  const palette = $('regionActionPalette');
  if (!palette) return;
  palette.style.left = `${x}px`;
  palette.style.top = `${y}px`;
  palette.classList.add('vip-context-palette--visible');
}

function hideContextPalette() {
  const palette = $('regionActionPalette');
  if (!palette) return;
  palette.classList.remove('vip-context-palette--visible');
}

function setSelection(start, end) {
  const s = Math.min(start, end);
  const e = Math.max(start, end);
  if (Math.abs(e - s) < 0.005) {
    state.selection = null;
    hideContextPalette();
  } else {
    state.selection = { start: s, end: e };
    sessionStore.selectRegion({ id: 'manual-selection', start: s * state.duration, end: e * state.duration, startNorm: s, endNorm: e });
  }
  updateSelectionInfo();
  drawWaveform($('engineerWaveCanvas'), state.channelData);
  drawSpectrogram($('engineerSpecCanvas'));
  // Show contextual palette at selection center
  if (state.selection) {
    const canvas = $('engineerWaveCanvas');
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      const centerX = rect.left + ((state.selection.start + state.selection.end) / 2) * rect.width;
      const centerY = rect.top + rect.height / 2;
      // Position palette near selection but inside viewport
      showContextPalette(Math.min(window.innerWidth - 320, centerX - 100), centerY + 20);
    }
  }
}

function wireSelection() {
  const waveCanvas = $('engineerWaveCanvas');
  const specCanvas = $('engineerSpecCanvas');
  if (!waveCanvas) return;

  // Waveform horizontal drag
  waveCanvas.addEventListener('pointerdown', (e) => {
    waveCanvas.setPointerCapture(e.pointerId);
    state.isDragging = true;
    state.dragStart = getNormX(e, waveCanvas);
    state.selection = { start: state.dragStart, end: state.dragStart };
    e.preventDefault();
  });

  waveCanvas.addEventListener('pointermove', (e) => {
    if (!state.isDragging) return;
    const current = getNormX(e, waveCanvas);
    state.selection = { start: Math.min(state.dragStart, current), end: Math.max(state.dragStart, current) };
    // <100ms feedback: immediate redraw without waiting for animation frame? Use rAF for 60fps but still <16ms
    drawWaveform(waveCanvas, state.channelData);
    updateSelectionInfo();
  });

  waveCanvas.addEventListener('pointerup', (e) => {
    if (!state.isDragging) return;
    state.isDragging = false;
    const current = getNormX(e, waveCanvas);
    setSelection(state.dragStart, current);
    try { waveCanvas.releasePointerCapture(e.pointerId); } catch {}
  });

  // Spectrogram rectangle drag
  if (specCanvas) {
    specCanvas.addEventListener('pointerdown', (e) => {
      specCanvas.setPointerCapture(e.pointerId);
      const rect = specCanvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * specCanvas.width;
      const y = ((e.clientY - rect.top) / rect.height) * specCanvas.height;
      state.spectrogramDrag = { x0: x, y0: y, x1: x, y1: y };
      e.preventDefault();
    });

    specCanvas.addEventListener('pointermove', (e) => {
      if (!state.spectrogramDrag) return;
      const rect = specCanvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * specCanvas.width;
      const y = ((e.clientY - rect.top) / rect.height) * specCanvas.height;
      state.spectrogramDrag.x1 = x;
      state.spectrogramDrag.y1 = y;
      // Also update waveform selection from spectrogram X
      const startNorm = Math.min(state.spectrogramDrag.x0, state.spectrogramDrag.x1) / specCanvas.width;
      const endNorm = Math.max(state.spectrogramDrag.x0, state.spectrogramDrag.x1) / specCanvas.width;
      state.selection = { start: startNorm, end: endNorm };
      drawSpectrogram(specCanvas);
      drawWaveform(waveCanvas, state.channelData);
    });

    specCanvas.addEventListener('pointerup', (e) => {
      if (!state.spectrogramDrag) return;
      const drag = state.spectrogramDrag;
      state.spectrogramDrag = null;
      const startNorm = Math.min(drag.x0, drag.x1) / specCanvas.width;
      const endNorm = Math.max(drag.x0, drag.x1) / specCanvas.width;
      setSelection(startNorm, endNorm);
      try { specCanvas.releasePointerCapture(e.pointerId); } catch {}
    });
  }

  // Clear on Escape
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      state.selection = null;
      state.spectrogramDrag = null;
      hideContextPalette();
      drawWaveform(waveCanvas, state.channelData);
      drawSpectrogram(specCanvas);
      updateSelectionInfo();
    }
  });

  // Click outside to hide palette
  document.addEventListener('pointerdown', (e) => {
    const palette = $('regionActionPalette');
    const canvasHost = $('unifiedSignalCanvas');
    if (!palette || !canvasHost) return;
    if (!canvasHost.contains(e.target) && !palette.contains(e.target)) {
      hideContextPalette();
    }
  });
}

// ── Contextual actions ────────────────────────────────────────────────────
function wireContextualActions() {
  const palette = $('regionActionPalette');
  if (!palette) return;

  palette.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (!state.selection) return;

    const startSec = state.selection.start * state.duration;
    const endSec = state.selection.end * state.duration;

    // Dispatch to session store
    sessionStore.setSelection(state.selection);
    // Trigger processing via existing engineer pipeline if available
    if (window.__vipEngineerProcessSelection) {
      window.__vipEngineerProcessSelection({ action, startSec, endSec, startNorm: state.selection.start, endNorm: state.selection.end });
    } else {
      // Fallback: toast
      const detail = `${action} ${startSec.toFixed(2)}s → ${endSec.toFixed(2)}s`;
      console.log('[VIP][premium] contextual action', detail);
      // Update status
      const badge = $('vip-proc-badge');
      if (badge) {
        const label = badge.querySelector('.vip-pb-label');
        if (label) label.textContent = `${action} on selection ${detail} · local`;
      }
    }

    // Haptic for Android
    if (platform && platform.vibrate) {
      platform.vibrate(20);
    }

    hideContextPalette();
  });
}

// ── Profiles ──────────────────────────────────────────────────────────────
function wireProfiles() {
  const container = $('engineerProfiles');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-profile]');
    if (!btn) return;
    const profile = btn.dataset.profile;
    container.querySelectorAll('[data-profile]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    sessionStore.setActiveProfile(profile);
    // Apply profile to existing DSP controls if engineer app has it
    if (window.__vipApplyProfile) {
      window.__vipApplyProfile(profile);
    }
    // Update UI store
    uiStore.setActiveProfile?.(profile);
  });
}

// ── Comparison Raw/Processed/Removed ──────────────────────────────────────
function wireComparison() {
  const container = $('engineerCompareToggle');
  if (!container) return;
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-compare]');
    if (!btn) return;
    const mode = btn.dataset.compare;
    container.querySelectorAll('[data-compare]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    const modeMap = { raw: ComparisonModes.RAW, processed: ComparisonModes.PROCESSED, removed: ComparisonModes.REMOVED };
    const mapped = modeMap[mode] || mode;
    sessionStore.setComparisonMode(mapped);
    // Also trigger existing A/B if available
    if (window.__vipSetComparisonMode) {
      window.__vipSetComparisonMode(mapped);
    }
  });

  // Subscribe to session store for external changes
  sessionStore.subscribe((state) => {
    const currentMode = state.comparisonMode;
    if (!currentMode) return;
    const reverseMap = { [ComparisonModes.RAW]: 'raw', [ComparisonModes.PROCESSED]: 'processed', [ComparisonModes.REMOVED]: 'removed' };
    const key = reverseMap[currentMode] || currentMode;
    container.querySelectorAll('[data-compare]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.compare === key));
    });
  });
}

// ── Live Metrics ──────────────────────────────────────────────────────────
function updateLiveMetrics(metrics) {
  if (!metrics) return;
  const setMetric = (id, value, fillId, max = 100) => {
    const el = $(id);
    const fill = $(fillId);
    if (el) el.textContent = value;
    if (fill) {
      const num = parseFloat(value);
      const pct = isNaN(num) ? 0 : Math.min(100, Math.max(0, (num / max) * 100));
      fill.style.width = `${pct}%`;
    }
  };

  if (metrics.voiceClarity != null) setMetric('metricVoiceClarity', `${Math.round(metrics.voiceClarity)}%`, 'metricVoiceClarityFill');
  if (metrics.noiseReduction != null) setMetric('metricNoiseReduction', `${metrics.noiseReduction.toFixed(1)} dB`, 'metricNoiseReductionFill', 60);
  if (metrics.whisperRetention != null) setMetric('metricWhisperRetention', `${Math.round(metrics.whisperRetention)}%`, 'metricWhisperRetentionFill');
  if (metrics.outputLevelDb != null || metrics.outputDb != null) {
    const db = metrics.outputLevelDb ?? metrics.outputDb;
    setMetric('metricOutputDb', `${db.toFixed(1)} dBFS`, 'metricOutputDbFill', 1);
  }

  // Deep metrics
  const deepMap = {
    deepSnr: metrics.snrDb != null ? `${metrics.snrDb.toFixed(1)}` : null,
    deepRms: metrics.rms != null ? metrics.rms.toFixed(4) : null,
    deepPeak: metrics.peak != null ? metrics.peak.toFixed(4) : null,
    deepLufs: metrics.lufs != null ? `${metrics.lufs.toFixed(1)} LUFS` : null,
    deepVoices: metrics.voices != null ? String(metrics.voices) : null,
    deepDuration: metrics.duration != null ? `${metrics.duration.toFixed(2)}s` : null,
  };
  for (const [id, val] of Object.entries(deepMap)) {
    if (val != null) {
      const el = $(id);
      if (el) el.textContent = val;
    }
  }
}

function wireLiveMetrics() {
  sessionStore.subscribe((state) => {
    if (state.metrics) updateLiveMetrics(state.metrics);
    if (state.analysis) {
      // Update overlay list
      const list = $('analysisOverlayList');
      if (list && state.analysis.regions) {
        list.innerHTML = '';
        for (const r of state.analysis.regions.slice(0, 12)) {
          const div = document.createElement('div');
          div.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:#121a23;border:1px solid #1d2a34;border-radius:4px;font:500 11px/1 ui-sans-serif;';
          div.innerHTML = `<span style="color:#c5ced6;">${r.type} ${r.start?.toFixed ? r.start.toFixed(1) + 's' : ''}</span><span style="color:${r.confidence > 0.7 ? '#31cf7d' : r.confidence > 0.4 ? '#ffb948' : '#ff5a7a'};">${Math.round((r.confidence || 0) * 100)}%</span>`;
          list.appendChild(div);
        }
      }
    }
  });
}

// ── Zoom / Clear / Playback ───────────────────────────────────────────────
function wireInspectorActions() {
  $('btnZoomToSelection')?.addEventListener('click', () => {
    if (!state.selection) return;
    // Zoom: for now just redraw with zoomed view — in real app would set zoom state
    console.log('[VIP][premium] zoom to selection', state.selection);
    uiStore.setZoom?.(state.selection);
  });

  $('btnClearSelection')?.addEventListener('click', () => {
    state.selection = null;
    state.spectrogramDrag = null;
    hideContextPalette();
    drawWaveform($('engineerWaveCanvas'), state.channelData);
    drawSpectrogram($('engineerSpecCanvas'));
    updateSelectionInfo();
  });

  $('btnSelectedPlayback')?.addEventListener('click', () => {
    if (!state.selection) return;
    const startSec = state.selection.start * state.duration;
    const endSec = state.selection.end * state.duration;
    if (window.__vipPlaySelection) {
      window.__vipPlaySelection(startSec, endSec);
    } else {
      console.log('[VIP][premium] play selection', startSec, endSec);
    }
  });
}

// ── Automatic analysis on import ──────────────────────────────────────────
async function handleFileImported(detail) {
  const { channelData, sampleRate, duration } = detail;
  state.channelData = channelData;
  state.sampleRate = sampleRate;
  state.duration = duration || (channelData[0]?.length / sampleRate) || 0;

  drawWaveform($('engineerWaveCanvas'), channelData);
  drawSpectrogram($('engineerSpecCanvas'));

  // Run auto analysis if not already running
  try {
    sessionStore.startAnalysis();
    const result = await runAutoAnalysis(channelData, sampleRate, {
      onProgress: (pct, extra) => sessionStore.updateAnalysisProgress(pct, extra),
    });
    sessionStore.setAnalysisResult(result);
    drawWaveform($('engineerWaveCanvas'), channelData);
  } catch (e) {
    console.warn('[VIP][premium] auto analysis failed', e);
  }
}

// ── Navigation active state ───────────────────────────────────────────────
function wireNav() {
  const nav = document.querySelector('.vip-engineer-nav');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const item = e.target.closest('[data-nav]');
    if (!item) return;
    nav.querySelectorAll('[data-nav]').forEach((el) => el.classList.remove('vip-engineer-nav__item--active'));
    item.classList.add('vip-engineer-nav__item--active');
  });
}

// ── Platform adapter ──────────────────────────────────────────────────────
function initPlatform() {
  try {
    platform.init?.();
    // Keyboard shortcuts
    platform.setupKeyboardShortcuts?.({
      playPause: () => window.__vipTogglePlay?.(),
      abToggle: () => {
        const modes = [ComparisonModes.RAW, ComparisonModes.PROCESSED, ComparisonModes.REMOVED];
        const current = sessionStore.getState().comparisonMode;
        const idx = modes.indexOf(current);
        const next = modes[(idx + 1) % modes.length];
        sessionStore.setComparisonMode(next);
      },
      clearSelection: () => {
        state.selection = null;
        hideContextPalette();
        drawWaveform($('engineerWaveCanvas'), state.channelData);
        drawSpectrogram($('engineerSpecCanvas'));
      },
      toggleLoop: () => window.__vipToggleLoop?.(),
      cropIn: () => window.__vipCropIn?.(),
      cropOut: () => window.__vipCropOut?.(),
    });
  } catch (e) {
    console.warn('[VIP][premium] platform init failed', e);
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
function init() {
  wireSelection();
  wireContextualActions();
  wireProfiles();
  wireComparison();
  wireLiveMetrics();
  wireInspectorActions();
  wireNav();
  initPlatform();

  // Listen for file import from existing engineer app
  window.addEventListener('vip:fileImported', (e) => {
    handleFileImported(e.detail);
  });

  // Also listen for existing app's ingestion if it exposes channelData differently
  window.addEventListener('vip:engineerFileImported', (e) => {
    handleFileImported(e.detail);
  });

  // Initial draw
  drawWaveform($('engineerWaveCanvas'), null);
  drawSpectrogram($('engineerSpecCanvas'));

  console.log('[VIP][premium] Engineer workspace initialized — signal-first, 100% local');
}

// Expose for existing app to call
window.__vipPremiumWorkspace = { init, handleFileImported, setSelection, drawWaveform, drawSpectrogram, state };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
