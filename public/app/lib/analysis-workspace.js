/**
 * Engineer Mode — Analysis Workspace Controller
 * Wires full analysis, timeline, audition, recommendations into the UI.
 * 100% local. Imports canonical logic from /src/.
 *
 * Universal Source Matrix is an **internal backend** (not a user Separate panel):
 * after Full Analysis completes, USMNode.ensureComputed() runs once per file
 * (worker-backed), caches stems, and exposes getSourceStems()/getSourceLabels()
 * for chips + WhisperHunter. Mute/solo live only in SourceAuditionEngine.
 */
'use strict';

import { FullAnalysisHost } from '/src/pipeline/FullAnalysisHost.js';
import { SourceAuditionEngine } from '/src/pipeline/SourceAuditionEngine.js';
import { TimelineRenderer } from '/src/presentation/TimelineRenderer.js';
import { TransportSync } from '/src/presentation/TransportSync.js';
import { checkCapabilities, formatCapabilityLines } from '/src/core/CapabilityChecker.js';
import { getCalibratedPresets, resolvePresetName } from '/src/core/PresetCalibration.js';
import { buildMlProcessingConfig } from '/src/core/ParameterSchema.js';
import { exportAudioBuffer, safeFilename } from '/src/pipeline/ExportManager.js';
import { downmixToMono } from '/src/core/FeatureExtractor.js';
import {
  enrichAnalysisWithCollaboration,
  applyHunterFeedbackToAnalysis,
  analysisToHunterSliderTargets,
} from '/src/core/AnalyzerWhisperBridge.js';
import { analyzeAcousticEnvironment } from '../whisper-hunter.js';
import { USMNode, usmSourcesToAudioBuffers } from '/src/pipeline/USMNode.js';

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
    btnCollab: document.getElementById('btnAnalyzeWhisperCollab'),
    btnCancel: document.getElementById('btnCancelAnalysis'),
    progress: document.getElementById('analysisProgress'),
    progressFill: document.getElementById('analysisProgressFill'),
    progressLabel: document.getElementById('analysisProgressLabel'),
    findings: document.getElementById('analysisFindings'),
    reasons: document.getElementById('analysisReasons'),
    presetCard: document.getElementById('analysisPresetCard'),
    confBadge: document.getElementById('analysisConfidence'),
    chips: document.getElementById('analysisSourceChips'),
    collab: document.getElementById('analysisCollabStatus'),
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
    // Universal Source Matrix
    usmPanel: document.getElementById('sourceMatrixPanel'),
    btnUsmSeparate: document.getElementById('btnUsmSeparate'),
    btnUsmQuery: document.getElementById('btnUsmQuery'),
    btnUsmApplyMix: document.getElementById('btnUsmApplyMix'),
    usmNumSources: document.getElementById('usmNumSources'),
    usmQueryInput: document.getElementById('usmQueryInput'),
    usmTableBody: document.getElementById('usmTableBody'),
    usmProgress: document.getElementById('usmProgress'),
    usmProgressFill: document.getElementById('usmProgressFill'),
    usmProgressLabel: document.getElementById('usmProgressLabel'),
    usmError: document.getElementById('usmError'),
    usmMethodBadge: document.getElementById('usmMethodBadge'),
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
  const usmNode = new USMNode({
    preferOnnx: false, // classical USM default; set true when universal-separator.onnx ships
    onProgress: (pct, label) => {
      if (els.usmProgress) els.usmProgress.hidden = false;
      if (els.usmProgressFill) els.usmProgressFill.style.width = `${Math.round((pct || 0) * 100)}%`;
      if (els.usmProgressLabel) els.usmProgressLabel.textContent = `${label || 'usm'}… ${Math.round((pct || 0) * 100)}%`;
    },
  });
  let timeline = null;
  let lastAnalysis = null;
  let cancelled = false;
  let usmBusy = false;

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

  function showUsmError(msg) {
    if (!els.usmError) return;
    els.usmError.hidden = !msg;
    els.usmError.textContent = msg || '';
  }

  /**
   * Read-only Detected Sources summary (backend USM). Mute/solo live in
   * the Audition strip only — not Engineer sliders.
   */
  function renderUsmSummary() {
    const labels = typeof usmNode.getSourceLabels === 'function'
      ? usmNode.getSourceLabels()
      : (usmNode.sources || []).map((s) => ({
        id: s.id,
        label: s.label,
        confidence: s.confidence ?? 0,
        quality: s.quality || 'medium',
      }));
    if (els.usmMethodBadge) {
      const method = usmNode._lastResult?.method || (labels.length ? 'usm' : '');
      els.usmMethodBadge.hidden = !method;
      if (method) els.usmMethodBadge.textContent = method;
    }
    // Compact chip list inside USM panel (if present)
    if (els.usmTableBody) {
      if (!labels.length) {
        els.usmTableBody.innerHTML =
          '<tr class="usm-empty-row"><td colspan="2">Sources appear after Analyze Full Audio (computed automatically).</td></tr>';
      } else {
        els.usmTableBody.innerHTML = labels.map((s) => `
          <tr data-usm-id="${escapeHtml(s.id)}">
            <td>${escapeHtml(s.label)}</td>
            <td><span class="usm-conf" title="Confidence">${Math.round((s.confidence || 0) * 100)}%</span>
              <span class="aud-quality q-${escapeHtml(s.quality || 'medium')}">${escapeHtml(s.quality || 'medium')}</span>
            </td>
          </tr>`).join('');
      }
    }
    // Also merge into analysis source chips when USM labels available
    if (els.chips && labels.length) {
      const existing = new Set(
        [...els.chips.querySelectorAll('.source-chip')].map((b) => b.dataset.source),
      );
      for (const s of labels) {
        if (existing.has(s.id)) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'source-chip source-chip--usm';
        btn.dataset.source = s.id;
        btn.title = `USM · confidence ${Math.round((s.confidence || 0) * 100)}%`;
        btn.innerHTML = `${escapeHtml(s.label)} <span class="chip-conf">${Math.round((s.confidence || 0) * 100)}%</span>`;
        btn.addEventListener('click', () => {
          audition.setMode('layer');
          for (const L of audition.layers.values()) L.solo = false;
          const layer = audition.layers.get(s.id);
          if (layer) {
            layer.solo = true;
            audition.play().catch(() => {});
          }
        });
        els.chips.appendChild(btn);
      }
    }
  }

  /** @deprecated name kept for any external callers */
  function renderUsmTable() {
    renderUsmSummary();
  }

  async function pushUsmToAudition() {
    const ctx = app.ctx || app.audioCtx;
    if (!ctx) return;
    if (ctx.state === 'suspended') await ctx.resume();
    const original = app.origBuffer || app.inputBuffer;
    const packed = usmSourcesToAudioBuffers(ctx, usmNode.sources, usmNode.sampleRate);
    audition.buildFromUSM(packed, ctx, original || null);
    transport.attachClock(() => audition.getCurrentTime());
    renderAuditionStrip();
    setModeButtons('layer');
  }

  /** Re-snap Live-Mix if audition is already playing (gain nodes are one-shot per play). */
  function refreshAuditionIfPlaying() {
    if (!audition._playing) return;
    const t = typeof audition.getCurrentTime === 'function' ? audition.getCurrentTime() : 0;
    audition.play(t).catch(() => {});
  }

  /**
   * Backend USM: compute once after analysis (or on demand for WhisperHunter).
   * Never called from mute/solo/slider. Progress updates chips only.
   */
  async function runUsmBackend(opts = {}) {
    if (usmBusy) return usmNode.isReady?.() ? {
      sources: usmNode.sources,
      method: usmNode._lastResult?.method,
      cached: true,
    } : null;
    showUsmError('');
    const buf = app.origBuffer || app.inputBuffer;
    if (!buf) return null;
    usmBusy = true;
    if (els.usmProgress) els.usmProgress.hidden = false;
    try {
      const channels = [];
      for (let c = 0; c < buf.numberOfChannels; c++) {
        channels.push(buf.getChannelData(c).slice());
      }
      const K = Math.max(2, Math.min(12, Number(opts.numSources) || 6));
      const config = {
        mode: opts.mode === 'query' ? 'query' : 'auto',
        numSources: K,
        queries: opts.queries || [],
        nmfIterations: opts.nmfIterations || 20,
      };
      const result = typeof usmNode.ensureComputed === 'function'
        ? await usmNode.ensureComputed(channels, buf.sampleRate, config)
        : await usmNode.process(channels, buf.sampleRate, config);
      app._usmResult = result;
      app._usmNode = usmNode;
      // Expose internal API on app for WhisperHunter / Process consumers
      app.getSourceStems = () => usmNode.getSourceStems();
      app.getSourceLabels = () => usmNode.getSourceLabels();

      await pushUsmToAudition();
      renderUsmSummary();
      if (typeof app.setStatus === 'function' && !result.cached) {
        app.setStatus(`Detected ${result.sources.length} sources (${result.method})`);
      }
      return result;
    } catch (err) {
      showUsmError(err?.message || String(err));
      return null;
    } finally {
      usmBusy = false;
      if (els.usmProgress) els.usmProgress.hidden = true;
    }
  }

  /** @deprecated user-facing Separate removed — maps to backend auto mode */
  async function runUsmSeparate(mode) {
    return runUsmBackend({ mode: mode === 'query' ? 'query' : 'auto' });
  }

  function applyUsmMixToProcessed() {
    if (!usmNode.sources.length) {
      showUsmError('Run Analyze Full Audio first (USM computes automatically).');
      return;
    }
    const ctx = app.ctx || app.audioCtx;
    if (!ctx) {
      showUsmError('Audio context not ready');
      return;
    }
    const mix = usmNode.renderMix();
    const sr = usmNode.sampleRate || ctx.sampleRate;
    const srcBuf = app.origBuffer || app.inputBuffer;
    const nCh = Math.max(1, Math.min(2, srcBuf?.numberOfChannels || 1));
    const out = ctx.createBuffer(nCh, mix.length, sr);
    for (let c = 0; c < nCh; c++) out.copyToChannel(mix, c);
    app.procBuffer = out;
    app.outputBuffer = out;
    audition.setLayer({
      id: 'processed',
      label: 'USM mix (processed)',
      buffer: out,
      confidence: 1,
      quality: 'high',
    });
    renderAuditionStrip();
    if (typeof app.setStatus === 'function') {
      app.setStatus('USM mix applied to processed buffer');
    }
    showUsmError('');
  }

  function setBusy(busy) {
    [els.btnAnalyze, els.btnApplyRec, els.btnAutoProcess, els.btnCollab].forEach((b) => {
      if (b) b.disabled = !!busy;
    });
    if (els.btnCancel) els.btnCancel.hidden = !busy;
  }

  /**
   * Fuse analyzer result with WhisperHunter acoustic env (local, no cloud).
   * Stores joint plan on app for WHISPER_HUNTER.run and Process to consume.
   */
  function collaborateWithHunter(analysis, audioBuffer) {
    if (!analysis) return analysis;
    let envProfile = null;
    try {
      if (audioBuffer && typeof analyzeAcousticEnvironment === 'function') {
        envProfile = analyzeAcousticEnvironment(audioBuffer);
      }
    } catch (err) {
      console.warn('[VIP] analyzeAcousticEnvironment failed in collaborateWithHunter', err?.message);
      envProfile = null;
    }
    const enriched = enrichAnalysisWithCollaboration(analysis, envProfile);
    app._lastFullAnalysis = enriched;
    app._jointIsolationPlan = enriched.jointPlan || null;
    app._hunterEnvFromAnalysis = envProfile;
    lastAnalysis = enriched;
    return enriched;
  }

  function renderCollabStatus(analysis) {
    if (!els.collab) return;
    const plan = analysis?.jointPlan;
    if (!plan?.ok) {
      els.collab.hidden = true;
      els.collab.innerHTML = '';
      return;
    }
    const u = plan.unwanted;
    const badges = (u?.present || []).map((key) => {
      const c = u.classes[key];
      return `<span class="collab-badge collab-badge--suppress" title="${escapeHtml(c.hint)}">${escapeHtml(c.label)}</span>`;
    });
    if ((analysis.whisperRegions || []).length) {
      badges.unshift(
        `<span class="collab-badge collab-badge--protect">Whisper ×${analysis.whisperRegions.length}</span>`,
      );
    }
    if ((analysis.speechSegments || []).length) {
      badges.unshift(
        `<span class="collab-badge collab-badge--protect">Voice zones ×${analysis.speechSegments.length}</span>`,
      );
    }
    els.collab.hidden = false;
    els.collab.innerHTML = `
      <div class="collab-title">Analyzer ↔ WhisperHunter</div>
      <p class="collab-summary">${escapeHtml(plan.collaboration?.summary || 'Joint isolation map ready')}</p>
      <div class="collab-badges">${badges.join('') || '<span class="collab-badge">No strong interference</span>'}</div>
      <p class="collab-meta">Protect ${plan.protectRegions?.length || 0} · Suppress ${plan.suppressRegions?.length || 0} · Preset <strong>${escapeHtml(plan.recommendedPreset || '—')}</strong></p>`;
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
    if (analysis?.jointPlan) app._jointIsolationPlan = analysis.jointPlan;

    if (timeline) timeline.setAnalysis(analysis);
    transport.setDuration(analysis.duration || 0);

    if (els.confBadge) {
      const c = analysis.recommendation?.confidence ?? analysis.confidenceScores?.analysisQuality ?? 0;
      els.confBadge.textContent = `Confidence ${(c * 100).toFixed(0)}%`;
      els.confBadge.dataset.level = c >= 0.7 ? 'high' : c >= 0.5 ? 'mid' : 'low';
    }

    if (els.presetCard) {
      const rec = analysis.recommendation;
      const emphasize = rec?.recommendedProcessingPlan?.emphasize
        || analysis.jointPlan?.emphasize
        || [];
      els.presetCard.innerHTML = `
        <div class="rec-preset-name">${escapeHtml(rec?.recommendedPreset || '—')}</div>
        <div class="rec-preset-meta">Auto-apply: ${rec?.autoApplySafe ? 'safe' : 'review first'}</div>
        <div class="rec-emphasize">${emphasize.map(escapeHtml).join(' · ') || 'Balanced chain'}</div>`;
    }

    if (els.findings) {
      const items = analysis.recommendation?.findings || [];
      els.findings.innerHTML = items.map((f) => `<li>${escapeHtml(f)}</li>`).join('') || '<li>No findings</li>';
    }
    if (els.reasons) {
      const items = analysis.recommendation?.reasons || [];
      els.reasons.innerHTML = items.map((r) => `<li>${escapeHtml(r)}</li>`).join('') || '<li>—</li>';
    }

    renderCollabStatus(analysis);

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

  function clearState() {
    cancelled = false;
    lastAnalysis = null;
    app._lastFullAnalysis = null;
    app._jointIsolationPlan = null;
    app._hunterEnvFromAnalysis = null;
    app._usmResult = null;
    usmNode.clear?.();
    host.dispose();
    audition.stop(true);
    audition.resetMix();
    transport.stop(true);
    transport.setDuration(0);
    renderUsmSummary();
    if (timeline) {
      timeline.setAnalysis(null);
      timeline.setPlayhead(0);
    }
    if (els.confBadge) {
      els.confBadge.textContent = 'Confidence —';
      els.confBadge.dataset.level = 'low';
    }
    if (els.presetCard) {
      els.presetCard.innerHTML = `
        <div class="rec-preset-name">No recommendation yet</div>
        <div class="rec-preset-meta">Run Analyze Full Audio</div>`;
    }
    if (els.findings) els.findings.innerHTML = '<li>Load a file, then analyze.</li>';
    if (els.reasons) els.reasons.innerHTML = '<li>—</li>';
    if (els.chips) els.chips.innerHTML = '';
    if (els.collab) {
      els.collab.hidden = true;
      els.collab.innerHTML = '';
    }
    if (els.progress) els.progress.hidden = true;
    if (els.progressFill) els.progressFill.style.width = '0%';
    if (els.progressLabel) els.progressLabel.textContent = 'Idle';
    showError('');
    renderAuditionStrip();
    if (els.root) els.root.dataset.state = 'idle';
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
    const jobs = globalThis.__VIP_JOBS__;
    let job = null;
    // Decode on the analyzer path (not at upload) — keeps the tab responsive.
    if (typeof app.ensureDecoded === 'function') {
      const decoded = await app.ensureDecoded();
      if (!decoded) {
        showError('Load an audio or video file first, then analyze.');
        return null;
      }
    }
    const buf = app.origBuffer || app.inputBuffer;
    if (!buf) {
      showError('Load an audio or video file first.');
      return null;
    }
    setBusy(true);
    if (els.root) els.root.dataset.state = 'running';
    if (jobs?.beginJob) {
      job = jobs.beginJob('Full analysis', { kind: 'analysis' });
    }
    const signal = job?.controller?.signal || jobs?.getCurrentSignal?.() || null;
    const superseded = () => {
      const activeJobId = jobs?.getCurrentJobId?.() || null;
      return job?.cancelReason === 'superseded'
        || signal?.reason === 'superseded'
        || Boolean(activeJobId && job && activeJobId !== job.id);
    };
    if (typeof app.showProcessingOverlay === 'function') {
      app.showProcessingOverlay('Analyzing…', 0, 'analyzing', job?.id || null);
    }
    try {
      // Restore durable analysis when available (same library file after reload).
      const libId = app._libraryFileId;
      if (libId && !app._forceAnalysisRerun) {
        try {
          const { loadAnalysisDurable } = await import('/src/core/storage/DerivedCache.js');
          const cached = await loadAnalysisDurable(libId);
          if (cached && typeof cached === 'object') {
            if (signal?.aborted || superseded()) return null;
            let analysis = collaborateWithHunter(cached, buf);
            await ensureAuditionBuffers(analysis);
            if (signal?.aborted || superseded()) return null;
            renderAnalysis(analysis);
            if (typeof app.setStatus === 'function') {
              app.setStatus('Analysis restored from local cache');
            }
            if (els.progressLabel) els.progressLabel.textContent = 'Analysis restored (local cache)';
            // USM chips in background — never block listen/process
            void runUsmBackend({ mode: 'auto', numSources: 6 }).catch(() => {});
            if (job && jobs?.endJob) jobs.endJob(job.id, 'completed', { fromCache: true });
            return analysis;
          }
        } catch (cacheErr) {
          console.warn('[VIP] analysis cache load failed', cacheErr?.message);
        }
      }

      const channels = [];
      for (let c = 0; c < buf.numberOfChannels; c++) {
        channels.push(buf.getChannelData(c).slice());
      }
      // Use mono mix for speed on long files — still multi-channel aware via count
      const mono = downmixToMono(channels);
      const prevProgress = host.onProgress;
      const reportProgress = (pct, stage) => {
        try { prevProgress?.(pct, stage); } catch { /* ignore */ }
        if (signal?.aborted || superseded()) return;
        if (job && jobs?.updateJob) jobs.updateJob(job.id, stage || 'analysis', pct);
        if (typeof app.updateProcessingOverlay === 'function') {
          app.updateProcessingOverlay(stage || 'Analyzing…', pct, 8, job?.id || null);
        }
        if (els.progressLabel) els.progressLabel.textContent = `${stage || 'analysis'} · ${Math.round(pct || 0)}%`;
      };
      let analysis;
      analysis = await host.analyze([mono], buf.sampleRate, {
        platformHints: {
          lowMemory: /Android/i.test(navigator.userAgent || ''),
        },
        signal,
        onProgress: reportProgress,
      });
      if (cancelled || signal?.aborted || superseded()) {
        if (job && jobs?.endJob) jobs.endJob(job.id, 'cancelled');
        if (!superseded()) showError('Analysis cancelled');
        return null;
      }
      // Analyzer → WhisperHunter env fuse (protect voices, suppress horns/music/etc.)
      analysis = collaborateWithHunter(analysis, buf);
      if (libId) {
        try {
          const { saveAnalysisDurable } = await import('/src/core/storage/DerivedCache.js');
          await saveAnalysisDurable(libId, analysis);
          if (typeof app !== 'undefined' && app._libraryFileId) {
            // best-effort status on library meta
          }
        } catch (saveErr) {
          console.warn('[VIP] analysis cache save failed', saveErr?.message);
        }
      }
      if (signal?.aborted || superseded()) return null;
      await ensureAuditionBuffers(analysis);
      if (signal?.aborted || superseded()) return null;
      renderAnalysis(analysis);
      const preset = analysis.recommendedPreset || analysis.jointPlan?.recommendedPreset;
      if (typeof app.setStatus === 'function') {
        app.setStatus(`Analysis complete — ${preset || 'ready'} · joint isolation map ready`);
      } else if (els.progressLabel) {
        els.progressLabel.textContent = 'Analysis complete · Analyzer ↔ WhisperHunter linked';
      }
      // USM source matrix is optional and expensive — do NOT block Analyze on it.
      // Fire-and-forget so user can Process / listen immediately after analysis.
      if (els.progressLabel) els.progressLabel.textContent = 'Analysis complete — Process to isolate';
      if (typeof app.setStatus === 'function') {
        app.setStatus(`Analysis complete — ${preset || 'ready'} · Process to isolate (USM in background)`);
      }
      void runUsmBackend({ mode: 'auto', numSources: 6 })
        .then(() => {
          if (signal?.aborted || superseded()) return;
          const n = usmNode.getSourceLabels?.()?.length || usmNode.sources?.length || 0;
          if (els.progressLabel && n) {
            els.progressLabel.textContent = `Ready — ${n} source chip${n === 1 ? '' : 's'}`;
          }
        })
        .catch((e) => console.warn('[VIP] USM backend skipped:', e?.message || e));
      if (job && jobs?.endJob) jobs.endJob(job.id, 'completed');
      return analysis;
    } catch (err) {
      if (superseded()) return null;
      const cancelledErr = jobs?.isCancellationError?.(err)
        || /cancell?ed|aborted/i.test(String(err?.message || err));
      if (cancelledErr) {
        showError('Analysis cancelled');
        if (job && jobs?.endJob) jobs.endJob(job.id, 'cancelled', err);
      } else {
        showError(err.message || String(err));
        if (job && jobs?.endJob) jobs.endJob(job.id, 'error', err);
      }
      if (els.root) els.root.dataset.state = cancelledErr ? 'idle' : 'error';
      return null;
    } finally {
      const activeJob = jobs?.getCurrentJob?.() || null;
      const newerAnalysisOwnsWorkspace = Boolean(
        activeJob
        && activeJob.id !== job?.id
        && activeJob.status === 'running'
        && activeJob.meta?.kind === 'analysis'
      );
      if (!newerAnalysisOwnsWorkspace) {
        setBusy(false);
        if (els.progress) els.progress.hidden = true;
        if (els.root?.dataset.state === 'running') els.root.dataset.state = 'idle';
        if (typeof app.hideProcessingOverlay === 'function') {
          try { app.hideProcessingOverlay(job?.id || null); } catch { /* ignore */ }
        }
      }
    }
  }

  function applyRecommendations() {
    const analysis = lastAnalysis || app._lastFullAnalysis;
    if (!analysis?.recommendation && !analysis?.jointPlan) {
      showError('Run Analyze Full Audio first.');
      return;
    }
    const rec = analysis.recommendation || {};
    const plan = analysis.jointPlan;
    const presetName = resolvePresetName(plan?.recommendedPreset || rec.recommendedPreset);
    if (typeof app.applyPreset === 'function') {
      app.applyPreset(presetName);
    }
    // Prefer joint isolation stage config (analyzer + hunter)
    const cfg = {
      ...(rec.recommendedStageConfig || {}),
      ...(plan?.recommendedStageConfig || {}),
    };
    if (app.params) {
      Object.assign(app.params, cfg);
      if (window.VIP_PARAMS) Object.assign(window.VIP_PARAMS, cfg);
    }
    // Region maps for offline / WhisperHunter spectral protect-suppress
    app._protectRegions = plan?.protectRegions || analysis.protectRegions || [];
    app._suppressRegions = plan?.suppressRegions || analysis.suppressRegions || [];

    if (typeof app.syncSlidersFromParams === 'function') {
      app.syncSlidersFromParams();
    } else if (typeof app.updateAllSliders === 'function') {
      app.updateAllSliders();
    } else {
      for (const [k, v] of Object.entries(cfg)) {
        if (typeof app.onSlider === 'function') app.onSlider(k, v);
      }
    }
    const sel = document.getElementById('presetSel');
    if (sel) {
      const opt = [...sel.options].find((o) => o.value === presetName || o.textContent === presetName);
      if (opt) sel.value = opt.value;
    }
    if (typeof app.setStatus === 'function') {
      app.setStatus(`Applied joint plan: ${presetName}`);
    }
    showError('');
  }

  async function analyzeAndProcess() {
    // Full path: decode → analyze → USM separation → apply recs → Process (ML/DSP).
    const analysis = lastAnalysis || (await runAnalysis());
    if (!analysis) return;
    // USM is optional — never block Process/listen path.
    if (!usmNode.isReady?.() && !usmNode.sources?.length) {
      void runUsmBackend({ mode: 'auto', numSources: 6 }).catch((e) => {
        console.warn('[VIP] USM before process skipped:', e?.message || e);
      });
    }
    const rec = analysis.recommendation;
    if (rec && !rec.autoApplySafe) {
      showError('Low confidence — recommendations applied; review before relying on export.');
    }
    applyRecommendations();
    if (typeof app.process === 'function') {
      await app.process();
      if (lastAnalysis) await ensureAuditionBuffers(lastAnalysis);
    } else if (typeof app.runPipeline === 'function') {
      await app.runPipeline();
      if (lastAnalysis) await ensureAuditionBuffers(lastAnalysis);
    }
  }

  /**
   * Analyze → joint map → WhisperHunter isolation (uses analyzer protect/suppress).
   */
  async function analyzeAndWhisperCollab() {
    showError('');
    let analysis = lastAnalysis || app._lastFullAnalysis;
    if (!analysis) {
      analysis = await runAnalysis();
    } else if (!analysis.jointPlan) {
      const buf = app.origBuffer || app.inputBuffer;
      analysis = collaborateWithHunter(analysis, buf);
      renderAnalysis(analysis);
    }
    if (!analysis) return;

    applyRecommendations();

    const buf = app.inputBuffer || app.origBuffer;
    if (!buf) {
      showError('Load an audio or video file first.');
      return;
    }

    // Prefer WHISPER_HUNTER on app/window (wired in app.js)
    const hunter = (typeof window !== 'undefined' && window.WHISPER_HUNTER)
      || app.WHISPER_HUNTER
      || null;

    setBusy(true);
    if (els.root) els.root.dataset.state = 'running';
    if (els.progress) els.progress.hidden = false;
    if (els.progressLabel) els.progressLabel.textContent = 'WhisperHunter using analyzer map…';
    if (els.progressFill) els.progressFill.style.width = '35%';

    try {
      // Pre-load hunter slider targets from joint plan so run() can reuse them
      const env = app._hunterEnvFromAnalysis || null;
      const targets = analysisToHunterSliderTargets(analysis, env, 0.5);
      app._hunterSliderTargets = targets;
      app._preferAnalysisForHunter = true;

      if (hunter && typeof hunter.run === 'function') {
        await hunter.run(buf, app);
      } else if (typeof app.process === 'function') {
        await app.process();
      } else {
        showError('WhisperHunter not available — applied analyzer recommendations only.');
      }

      // Fold hunter feedback into analysis for UI
      const envAfter = app._lastHunterEnv || env;
      const maskConf = app._lastHunterMaskConf;
      const enriched = applyHunterFeedbackToAnalysis(analysis, {
        envProfile: envAfter,
        maskConfidence: maskConf,
        platform: app._lastHunterPlatform,
        message: app._lastHunterMessage,
      });
      lastAnalysis = enriched;
      app._lastFullAnalysis = enriched;
      renderAnalysis(enriched);
      if (lastAnalysis) await ensureAuditionBuffers(lastAnalysis);

      if (typeof app.setStatus === 'function') {
        app.setStatus('Analyzer ↔ WhisperHunter isolation complete');
      }
      if (typeof app.showNotification === 'function') {
        app.showNotification(
          enriched.jointPlan?.collaboration?.summary || 'Joint isolation finished',
          'info',
        );
      }
    } catch (err) {
      showError(err?.message || String(err));
      if (els.root) els.root.dataset.state = 'error';
    } finally {
      app._preferAnalysisForHunter = false;
      setBusy(false);
      if (els.progress) els.progress.hidden = true;
      if (els.root && els.root.dataset.state === 'running') els.root.dataset.state = 'ready';
    }
  }

  // Expose for Process auto-chain (Engineer Console) — same entry as Analyze button.
  app.runFullAnalysis = runAnalysis;
  app._analysisWorkspaceApi = {
    runAnalysis,
    analyzeAndProcess,
    analyzeAndWhisperCollab,
    runUsmBackend,
  };

  // Events
  els.btnAnalyze?.addEventListener('click', () => { runAnalysis(); });
  els.btnApplyRec?.addEventListener('click', () => applyRecommendations());
  els.btnAutoProcess?.addEventListener('click', () => { analyzeAndProcess(); });
  els.btnCollab?.addEventListener('click', () => { analyzeAndWhisperCollab(); });
  els.btnCancel?.addEventListener('click', () => {
    cancelled = true;
    try {
      if (typeof host.cancelActive === 'function') host.cancelActive();
      else host.dispose();
      globalThis.__VIP_JOBS__?.cancelCurrent?.('user');
      if (typeof app?.hideProcessingOverlay === 'function') app.hideProcessingOverlay();
    } catch { /* ignore */ }
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
    const rawParams = globalThis.VIP_PARAMS || app.params || {};
    const params = typeof app.getEffectiveParams === 'function'
      ? app.getEffectiveParams(rawParams)
      : rawParams;
    const ditherAmt = buildMlProcessingConfig(params).export.ditherAmt;
    const result = await exportAudioBuffer(buf, name, { ditherAmt });
    if (!result.ok) showError(result.error || 'Export failed');
    else if (typeof app.setStatus === 'function') app.setStatus(`Exported ${result.filename}`);
  });

  // USM is backend-only: hide legacy Separate/Query buttons if still in DOM.
  [els.btnUsmSeparate, els.btnUsmQuery, els.btnUsmApplyMix].forEach((b) => {
    if (b) {
      b.hidden = true;
      b.setAttribute('aria-hidden', 'true');
    }
  });
  if (els.usmQueryInput) {
    els.usmQueryInput.hidden = true;
    els.usmQueryInput.setAttribute('aria-hidden', 'true');
  }
  if (els.usmNumSources) {
    const wrap = els.usmNumSources.closest?.('.usm-k-label') || els.usmNumSources;
    if (wrap) wrap.hidden = true;
  }

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
    analyzeAndWhisperCollab,
    collaborateWithHunter,
    clearState,
    getAnalysis: () => lastAnalysis,
    getJointPlan: () => lastAnalysis?.jointPlan || app._jointIsolationPlan || null,
    audition,
    host,
    usmNode,
    /** Backend API */
    runUsmBackend,
    getSourceStems: () => usmNode.getSourceStems(),
    getSourceLabels: () => usmNode.getSourceLabels(),
    runUsmSeparate, // deprecated alias
    applyUsmMixToProcessed,
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
