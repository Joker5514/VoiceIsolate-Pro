/**
 * Engineer Mode — Analysis Workspace Controller
 * Wires full analysis, timeline, audition, recommendations into the UI.
 * 100% local. Imports canonical logic from /src/.
 */
'use strict';

import { FullAnalysisHost } from '/src/pipeline/FullAnalysisHost.js';
import { SourceAuditionEngine } from '/src/pipeline/SourceAuditionEngine.js';
import { TimelineRenderer } from '/src/presentation/TimelineRenderer.js';
import { TransportSync } from '/src/presentation/TransportSync.js';
import { checkCapabilities, formatCapabilityLines } from '/src/core/CapabilityChecker.js';
import { getCalibratedPresets, resolvePresetName } from '/src/core/PresetCalibration.js';
import { exportAudioBuffer, safeFilename } from '/src/pipeline/ExportManager.js';
import { downmixToMono } from '/src/core/FeatureExtractor.js';

/**
 * @param {object} app VoiceIsolatePro instance (legacy Engineer shell)
 */
export function installAnalysisWorkspace(app) {
  if (!app || app._analysisWorkspace) return app._analysisWorkspace;

  // Expose installer for app.js init (avoids dynamic import() in app.js for Jest eval).
  if (typeof window !== 'undefined') {
    window.__VIP_INSTALL_ANALYSIS_WORKSPACE__ = installAnalysisWorkspace;
  }

  const els = {
    root: document.getElementById('analysisWorkspace'),
    btnAnalyze: document.getElementById('btnAnalyzeFull'),
    btnApplyRec: document.getElementById('btnApplyRecommendations'),
    btnAutoProcess: document.getElementById('btnAnalyzeProcessAuto'),
    btnCancel: document.getElementById('btnCancelAnalysis'),
    progress: document.getElementById('analysisProgress'),
    progressFill: document.getElementById('analysisProgressFill'),
    progressLabel: document.getElementById('analysisProgressLabel'),
    findings: document.getElementById('analysisFindings'),
    reasons: document.getElementById('analysisReasons'),
    presetCard: document.getElementById('analysisPresetCard'),
    confBadge: document.getElementById('analysisConfidence'),
    chips: document.getElementById('analysisSourceChips'),
    timeline: document.getElementById('analysisTimeline'),
    audition: document.getElementById('auditionStrip'),
    capPanel: document.getElementById('capabilityPanel'),
    error: document.getElementById('analysisError'),
    modeOriginal: document.getElementById('audModeOriginal'),
    modeLayer: document.getElementById('audModeLayer'),
    modeProcessed: document.getElementById('audModeProcessed'),
    btnAudPlay: document.getElementById('audPlay'),
    btnAudStop: document.getElementById('audStop'),
    btnAudReset: document.getElementById('audResetMix'),
    btnExport: document.getElementById('btnExportAnalysisWav'),
  };

  const host = new FullAnalysisHost({
    onProgress: (pct, stage) => {
      if (els.progress) els.progress.hidden = false;
      if (els.progressFill) els.progressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
      if (els.progressLabel) els.progressLabel.textContent = `${stage || 'analyzing'}… ${Math.round(pct)}%`;
    },
  });

  const audition = new SourceAuditionEngine();
  const transport = new TransportSync();
  let timeline = null;
  let lastAnalysis = null;
  let cancelled = false;

  if (els.timeline) {
    timeline = new TimelineRenderer(els.timeline, {
      onRegionClick: (hit) => {
        if (hit.segment) {
          audition.setRegion(hit.segment.start, hit.segment.end);
          audition.setLoop(true);
          if (hit.layer?.id) {
            audition.setMode('layer');
            for (const L of audition.layers.values()) L.solo = false;
            const layer = audition.layers.get(hit.layer.id);
            if (layer) layer.solo = true;
          }
          audition.play(hit.segment.start).catch(() => {});
        } else if (hit.time != null) {
          audition.seek(hit.time);
        }
      },
    });
  }

  transport.onUpdate((t) => {
    if (timeline) timeline.setPlayhead(t);
  });
  audition.onTimeUpdate((t) => transport.seek(t));

  function showError(msg) {
    if (!els.error) return;
    els.error.hidden = !msg;
    els.error.textContent = msg || '';
  }

  function setBusy(busy) {
    [els.btnAnalyze, els.btnApplyRec, els.btnAutoProcess].forEach((b) => {
      if (b) b.disabled = !!busy;
    });
    if (els.btnCancel) els.btnCancel.hidden = !busy;
  }

  function renderCapability() {
    if (!els.capPanel) return;
    const report = checkCapabilities({
      models: {
        demucs: true,
        rnnoise: true,
        bsrnn: true,
        vad: true,
      },
      worklets: {
        gate: true,
        deesser: true,
      },
    });
    app._capabilityReport = report;
    const lines = formatCapabilityLines(report);
    const summary = report.summary;
    els.capPanel.innerHTML = `
      <div class="cap-summary">
        <span class="cap-pill ${summary.ready ? 'ok' : 'bad'}">Ready</span>
        <span class="cap-pill ${summary.liveMix ? 'ok' : 'bad'}">Live-Mix</span>
        <span class="cap-pill ${summary.offlineMl ? 'ok' : 'warn'}">Offline ML</span>
        <span class="cap-pill ${summary.sab ? 'ok' : 'warn'}">SAB</span>
        <span class="cap-pill ${summary.webgpu ? 'ok' : 'warn'}">WebGPU</span>
      </div>
      <details class="cap-details"><summary>Capability details</summary>
        <pre class="cap-pre">${lines.map((l) => escapeHtml(l)).join('\n')}</pre>
      </details>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderAnalysis(analysis) {
    lastAnalysis = analysis;
    app._lastFullAnalysis = analysis;

    if (timeline) timeline.setAnalysis(analysis);
    transport.setDuration(analysis.duration || 0);

    if (els.confBadge) {
      const c = analysis.recommendation?.confidence ?? analysis.confidenceScores?.analysisQuality ?? 0;
      els.confBadge.textContent = `Confidence ${(c * 100).toFixed(0)}%`;
      els.confBadge.dataset.level = c >= 0.7 ? 'high' : c >= 0.5 ? 'mid' : 'low';
    }

    if (els.presetCard) {
      const rec = analysis.recommendation;
      els.presetCard.innerHTML = `
        <div class="rec-preset-name">${escapeHtml(rec?.recommendedPreset || '—')}</div>
        <div class="rec-preset-meta">Auto-apply: ${rec?.autoApplySafe ? 'safe' : 'review first'}</div>
        <div class="rec-emphasize">${(rec?.recommendedProcessingPlan?.emphasize || []).map(escapeHtml).join(' · ') || 'Balanced chain'}</div>`;
    }

    if (els.findings) {
      const items = analysis.recommendation?.findings || [];
      els.findings.innerHTML = items.map((f) => `<li>${escapeHtml(f)}</li>`).join('') || '<li>No findings</li>';
    }
    if (els.reasons) {
      const items = analysis.recommendation?.reasons || [];
      els.reasons.innerHTML = items.map((r) => `<li>${escapeHtml(r)}</li>`).join('') || '<li>—</li>';
    }

    if (els.chips) {
      els.chips.innerHTML = (analysis.detectedSources || []).map((s) => `
        <button type="button" class="source-chip" data-source="${escapeHtml(s.id)}" title="Confidence ${(s.confidence * 100).toFixed(0)}%">
          ${escapeHtml(s.label)}
          <span class="chip-conf">${(s.confidence * 100).toFixed(0)}%</span>
        </button>`).join('');
      els.chips.querySelectorAll('.source-chip').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.source;
          audition.setMode('layer');
          for (const L of audition.layers.values()) L.solo = false;
          const layer = audition.layers.get(id);
          if (layer) {
            layer.solo = true;
            audition.play().catch(() => {});
          }
        });
      });
    }

    renderAuditionStrip();
    if (els.root) els.root.dataset.state = 'ready';
  }

  function renderAuditionStrip() {
    if (!els.audition) return;
    const states = audition.getLayerStates().filter((s) => s.id !== 'original' || true);
    els.audition.innerHTML = states.map((s) => `
      <div class="aud-layer" data-id="${escapeHtml(s.id)}">
        <div class="aud-layer-head">
          <strong>${escapeHtml(s.label)}</strong>
          <span class="aud-quality q-${escapeHtml(s.quality)}" title="Layer quality (honest)">${escapeHtml(s.quality)}</span>
          <span class="aud-conf">${Math.round((s.confidence || 0) * 100)}%</span>
        </div>
        <div class="aud-layer-controls">
          <button type="button" class="btn btn-xs aud-solo ${s.solo ? 'active' : ''}" data-act="solo">Solo</button>
          <button type="button" class="btn btn-xs aud-mute ${s.muted ? 'active' : ''}" data-act="mute">Mute</button>
          <label class="aud-gain-label">Gain
            <input type="range" min="0" max="200" value="${Math.round((s.gain || 1) * 100)}" data-act="gain" />
          </label>
        </div>
      </div>`).join('') || '<p class="aud-empty">Run analysis to build audition layers.</p>';

    els.audition.querySelectorAll('.aud-layer').forEach((row) => {
      const id = row.dataset.id;
      row.querySelector('[data-act="solo"]')?.addEventListener('click', () => {
        const L = audition.layers.get(id);
        audition.setLayerSolo(id, !L?.solo);
        renderAuditionStrip();
      });
      row.querySelector('[data-act="mute"]')?.addEventListener('click', () => {
        const L = audition.layers.get(id);
        audition.setLayerMute(id, !L?.muted);
        renderAuditionStrip();
      });
      row.querySelector('[data-act="gain"]')?.addEventListener('input', (e) => {
        audition.setLayerGain(id, Number(e.target.value) / 100);
      });
    });
  }

  async function ensureAuditionBuffers(analysis) {
    const ctx = app.ctx || app.audioCtx;
    if (!ctx) throw new Error('Audio context not ready');
    if (ctx.state === 'suspended') await ctx.resume();

    const original = app.origBuffer || app.inputBuffer;
    const clean = app.procBuffer || app.outputBuffer || null;
    const noise = app.noiseBuffer || null;
    const processed = app.procBuffer || app.outputBuffer || null;

    audition.buildFromAnalysis({
      original,
      clean: clean || original,
      noise,
      processed,
      analysis,
    }, ctx);
    transport.attachClock(() => audition.getCurrentTime());
    renderAuditionStrip();
  }

  async function runAnalysis() {
    showError('');
    cancelled = false;
    const buf = app.origBuffer || app.inputBuffer;
    if (!buf) {
      showError('Load an audio or video file first.');
      return null;
    }
    setBusy(true);
    if (els.root) els.root.dataset.state = 'running';
    try {
      const channels = [];
      for (let c = 0; c < buf.numberOfChannels; c++) {
        channels.push(buf.getChannelData(c).slice());
      }
      // Use mono mix for speed on long files — still multi-channel aware via count
      const mono = downmixToMono(channels);
      const analysis = await host.analyze([mono], buf.sampleRate, {
        platformHints: {
          lowMemory: /Android/i.test(navigator.userAgent || ''),
        },
      });
      if (cancelled) return null;
      await ensureAuditionBuffers(analysis);
      renderAnalysis(analysis);
      if (typeof app.setStatus === 'function') {
        app.setStatus(`Analysis complete — ${analysis.recommendedPreset}`);
      } else if (els.progressLabel) {
        els.progressLabel.textContent = 'Analysis complete';
      }
      return analysis;
    } catch (err) {
      showError(err.message || String(err));
      if (els.root) els.root.dataset.state = 'error';
      return null;
    } finally {
      setBusy(false);
      if (els.progress) els.progress.hidden = true;
    }
  }

  function applyRecommendations() {
    const analysis = lastAnalysis || app._lastFullAnalysis;
    if (!analysis?.recommendation) {
      showError('Run Analyze Full Audio first.');
      return;
    }
    const rec = analysis.recommendation;
    const presetName = resolvePresetName(rec.recommendedPreset);
    if (typeof app.applyPreset === 'function') {
      app.applyPreset(presetName);
    }
    // Overlay stage config
    const cfg = rec.recommendedStageConfig || {};
    if (app.params) {
      Object.assign(app.params, cfg);
      if (window.VIP_PARAMS) Object.assign(window.VIP_PARAMS, cfg);
    }
    if (typeof app.syncSlidersFromParams === 'function') {
      app.syncSlidersFromParams();
    } else if (typeof app.updateAllSliders === 'function') {
      app.updateAllSliders();
    } else {
      // Push known rt params through bridge
      for (const [k, v] of Object.entries(cfg)) {
        if (typeof app.onSlider === 'function') app.onSlider(k, v);
      }
    }
    // Update preset select if present
    const sel = document.getElementById('presetSel');
    if (sel) {
      const opt = [...sel.options].find((o) => o.value === presetName || o.textContent === presetName);
      if (opt) sel.value = opt.value;
    }
    if (typeof app.setStatus === 'function') {
      app.setStatus(`Applied recommendation: ${presetName}`);
    }
    showError('');
  }

  async function analyzeAndProcess() {
    const analysis = lastAnalysis || (await runAnalysis());
    if (!analysis) return;
    const rec = analysis.recommendation;
    if (rec && !rec.autoApplySafe) {
      // Still apply but warn
      showError('Low confidence — recommendations applied; review before relying on export.');
    }
    applyRecommendations();
    if (typeof app.process === 'function') {
      await app.process();
      // Rebuild audition with processed output
      if (lastAnalysis) await ensureAuditionBuffers(lastAnalysis);
    }
  }

  // Events
  els.btnAnalyze?.addEventListener('click', () => { runAnalysis(); });
  els.btnApplyRec?.addEventListener('click', () => applyRecommendations());
  els.btnAutoProcess?.addEventListener('click', () => { analyzeAndProcess(); });
  els.btnCancel?.addEventListener('click', () => {
    cancelled = true;
    host.dispose();
    setBusy(false);
    showError('Analysis cancelled');
  });

  els.modeOriginal?.addEventListener('click', () => {
    audition.setMode('original');
    setModeButtons('original');
  });
  els.modeLayer?.addEventListener('click', () => {
    audition.setMode('layer');
    setModeButtons('layer');
  });
  els.modeProcessed?.addEventListener('click', () => {
    audition.setMode('processed');
    setModeButtons('processed');
  });

  function setModeButtons(mode) {
    [els.modeOriginal, els.modeLayer, els.modeProcessed].forEach((b) => {
      if (!b) return;
      b.classList.toggle('active', b.dataset.mode === mode);
    });
  }
  if (els.modeOriginal) els.modeOriginal.dataset.mode = 'original';
  if (els.modeLayer) els.modeLayer.dataset.mode = 'layer';
  if (els.modeProcessed) els.modeProcessed.dataset.mode = 'processed';

  els.btnAudPlay?.addEventListener('click', () => {
    transport.start();
    audition.play().catch((e) => showError(e.message));
  });
  els.btnAudStop?.addEventListener('click', () => {
    audition.stop(true);
    transport.stop(true);
  });
  els.btnAudReset?.addEventListener('click', () => {
    audition.resetMix();
    renderAuditionStrip();
  });

  els.btnExport?.addEventListener('click', async () => {
    const buf = app.procBuffer || app.outputBuffer || app.origBuffer;
    const name = safeFilename((app.fileName || 'voiceisolate') + '-export', 'wav');
    const result = await exportAudioBuffer(buf, name);
    if (!result.ok) showError(result.error || 'Export failed');
    else if (typeof app.setStatus === 'function') app.setStatus(`Exported ${result.filename}`);
  });

  // Inject calibrated presets into app if PRESETS exists
  try {
    const calibrated = getCalibratedPresets();
    if (app.constructor && typeof window !== 'undefined') {
      // Prefer merging into runtime PRESETS via app hook
      if (typeof app.replacePresets === 'function') {
        app.replacePresets(calibrated);
      }
    }
    // Populate preset select extras
    const sel = document.getElementById('presetSel');
    if (sel && calibrated) {
      const existing = new Set([...sel.options].map((o) => o.value));
      for (const name of Object.keys(calibrated)) {
        if (!existing.has(name)) {
          const opt = document.createElement('option');
          opt.value = name;
          opt.textContent = name;
          sel.appendChild(opt);
        }
      }
    }
  } catch { /* ignore */ }

  renderCapability();

  const api = {
    runAnalysis,
    applyRecommendations,
    analyzeAndProcess,
    getAnalysis: () => lastAnalysis,
    audition,
    host,
    refreshCapability: renderCapability,
  };
  app._analysisWorkspace = api;
  return api;
}

// Browser auto-wire: if Engineer app already booted, install immediately.
if (typeof window !== 'undefined') {
  window.__VIP_INSTALL_ANALYSIS_WORKSPACE__ = installAnalysisWorkspace;
  const pending = window.__VIP_PENDING_ANALYSIS_APP__ || window._vipApp;
  if (pending && !pending._analysisWorkspace) {
    try { installAnalysisWorkspace(pending); } catch (e) {
      console.warn('[analysis-workspace] deferred install failed', e);
    }
  }
}

export default { installAnalysisWorkspace };
