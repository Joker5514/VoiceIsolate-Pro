/**
 * VoiceIsolate Pro — Analysis Insights UI (Layer 4: Presentation)
 *
 * Runs post-process analysis on the clean stem and renders a compact
 * "Analysis Insights" panel into a provided DOM container.
 *
 * Architecture rules:
 *  - Imports only from pipeline and core layers (layers 1–3).
 *  - Never triggers ML inference (FullAnalysisHost uses only classical DSP +
 *    optional Silero VAD — it never re-runs the stem-separation models).
 *  - Analysis is cooperative: AbortSignal-guarded, non-blocking, and silently
 *    discarded if cancelled or superseded by a new file.
 *  - The panel is updated only when a non-stale validated snapshot is produced.
 */
'use strict';

import { FullAnalysisHost } from '../pipeline/FullAnalysisHost.js';
import { AnalysisCoordinator } from '../pipeline/AnalysisCoordinator.js';
import { recommendForGoal, SUPPORTED_GOALS } from '../core/IntelligenceRecommendation.js';
import { SAMPLE_RATE } from '../core/audio-config.js';

/** Map a FullAnalysis result to an AnalysisSnapshot accepted by IntelligenceContracts. */
function toSnapshot(analysis, { sessionId, contentFingerprint, analysisVersion = '1', backend: _backend = 'wasm' } = {}) {
  const evidenceRegions = [];
  let regionId = 0;

  // Map detected sources with segment evidence to EvidenceRegions.
  for (const src of analysis.detectedSources || []) {
    const detectionType = src.id; // e.g. 'speech', 'noise', 'hum'
    // Find a representative segment from the corresponding list.
    const segKey = detectionType === 'lead_speech' ? 'speechSegments'
      : detectionType === 'broadband_noise' || detectionType === 'noise' ? 'noiseSegments'
        : detectionType === 'hum' ? 'humSegments'
          : detectionType === 'ambience' ? 'reverbSegments'
            : null;
    const segs = segKey ? (analysis[segKey] || []) : [];
    const start = segs[0]?.start ?? 0;
    const end = segs[segs.length - 1]?.end ?? analysis.duration ?? 0;
    if (end <= start) continue;

    // Normalise detectionType to match IntelligenceRecommendation policy keys.
    const normType = detectionType === 'broadband_noise' ? 'background_noise'
      : detectionType === 'lead_speech' ? 'speech'
        : detectionType === 'music' ? 'music_bleed'
          : detectionType === 'hum' ? 'hum'
            : detectionType === 'ambience' ? 'reverb'
              : detectionType;

    const certainty = src.confidence >= 0.7 ? 'high'
      : src.confidence >= 0.4 ? 'medium'
        : 'low';

    evidenceRegions.push({
      id: `ev-${regionId++}`,
      startTime: start,
      endTime: end,
      detectionType: normType,
      certainty,
      evidence: { confidence: src.confidence, snrDb: analysis.snrDb ?? null },
      responsible: { id: 'classical-analysis', version: analysisVersion },
      availableActions: [],
      explanation: src.label
        ? `${src.label} detected (confidence ${Math.round(src.confidence * 100)}%).`
        : `Detected: ${normType}.`,
      support: 'supported',
    });
  }

  // Include a stationary_noise region when SNR is low or noise floor is measurable.
  const snrDb = analysis.snrDb ?? 0;
  if ((snrDb < 20 || (analysis.noiseSegments || []).length > 0) && evidenceRegions.every((r) => r.detectionType !== 'stationary_noise')) {
    evidenceRegions.push({
      id: `ev-${regionId++}`,
      startTime: 0,
      endTime: analysis.duration ?? 0,
      detectionType: 'stationary_noise',
      certainty: snrDb < 10 ? 'high' : snrDb < 20 ? 'medium' : 'low',
      evidence: { snrDb, noiseFloorDb: analysis.globalNoiseProfile?.floorDb ?? null },
      responsible: { id: 'classical-analysis', version: analysisVersion },
      availableActions: ['nrAmount'],
      explanation: `Measured SNR ${snrDb.toFixed(1)} dB. Background noise detected.`,
      support: 'supported',
    });
  }

  // Include a bandwidth_limited region when rolloff is low.
  if (analysis.confidenceScores?.bandwidthLimited && evidenceRegions.every((r) => r.detectionType !== 'bandwidth_limited')) {
    evidenceRegions.push({
      id: `ev-${regionId++}`,
      startTime: 0,
      endTime: analysis.duration ?? 0,
      detectionType: 'bandwidth_limited',
      certainty: 'medium',
      evidence: {},
      responsible: { id: 'classical-analysis', version: analysisVersion },
      availableActions: ['eqPresence'],
      explanation: 'Average spectral rolloff is below 4.5 kHz — speech may sound muffled.',
      support: 'supported',
    });
  }

  return {
    sessionId: sessionId || 'landing-local',
    contentFingerprint: contentFingerprint || 'unknown',
    input: {
      sampleRate: analysis.sampleRate ?? SAMPLE_RATE,
      channels: analysis.channels ?? 1,
      durationSeconds: analysis.duration ?? 0,
    },
    analysisVersion,
    timestamp: new Date().toISOString(),
    versions: {
      analyzer: 'classical-vad',
      rules: analysisVersion,
      vadSource: analysis.confidenceScores?.vadSource ?? 'none',
    },
    capabilities: {
      classicalDsp: { status: 'ready' },
      mlVad: { status: analysis.confidenceScores?.classicalOnly ? 'unavailable' : 'ready' },
    },
    measurements: {
      snrDb,
      rms: analysis.rms ?? 0,
      peak: analysis.peak ?? 0,
      speechRatio: analysis.confidenceScores?.speechRatio ?? 0,
      analysisQuality: analysis.confidenceScores?.analysisQuality ?? 0.55,
    },
    detectedSources: (analysis.detectedSources || []).map((s) => ({ id: s.id, label: s.label, confidence: s.confidence })),
    evidenceRegions,
    warnings: analysis.confidenceScores?.classicalOnly ? ['VAD uses classical features only; ML VAD unavailable.'] : [],
    unsupportedAnalyses: [],
    freshness: 'fresh',
  };
}

/** Derive a stable coordinator identity key from the analysis params. */
function coordIdentity(contentFingerprint, analysisVersion, backend) {
  return {
    contentFingerprint,
    analysisVersion,
    analyzerVersions: { classical: '1' },
    modelVersions: {},
    configuration: {},
    runtime: backend,
  };
}

/**
 * Escape user-facing text for safe insertion as textContent (no innerHTML needed;
 * all updates use .textContent, but kept here for documentation).
 */
function esc(text) { return String(text || '').trim(); }

/**
 * Render a compact source + recommendation panel into `container`.
 *
 * @param {Element} container - DOM element to populate (e.g. #sourceConfidencePanel)
 * @param {{ snapshot: object, recommendations: Array }} data
 */
function renderInsights(container, { snapshot, recommendations }) {
  container.dataset.state = 'ready';

  const sources = snapshot.detectedSources || [];
  const snrDb = snapshot.measurements?.snrDb;

  const parts = [];

  // ── Sources row ──────────────────────────────────────────────────────────
  if (sources.length) {
    const chips = sources
      .filter((s) => s.confidence >= 0.3)
      .map((s) => {
        const pct = Math.round(s.confidence * 100);
        const chip = document.createElement('span');
        chip.className = 'insight-chip';
        chip.textContent = `${esc(s.label)} (${pct}%)`;
        chip.title = `Detected: ${esc(s.label)}, confidence ${pct}%`;
        return chip;
      });
    if (chips.length) {
      const row = document.createElement('div');
      row.className = 'insight-sources';
      const label = document.createElement('span');
      label.className = 'insight-label';
      label.textContent = 'Detected: ';
      row.append(label, ...chips);
      parts.push(row);
    }
  }

  // ── SNR summary ──────────────────────────────────────────────────────────
  if (Number.isFinite(snrDb)) {
    const snrRow = document.createElement('p');
    snrRow.className = 'insight-snr';
    const quality = snrDb >= 25 ? 'Good' : snrDb >= 12 ? 'Fair' : 'Low';
    snrRow.textContent = `Signal quality: ${quality} · SNR ${snrDb.toFixed(1)} dB`;
    parts.push(snrRow);
  }

  // ── Actionable recommendations ───────────────────────────────────────────
  const executable = recommendations.filter((r) => r.recommendation.processingClass !== 'unsupported' && r.plan);
  if (executable.length) {
    const recList = document.createElement('ul');
    recList.className = 'insight-recs';
    for (const { recommendation } of executable) {
      const li = document.createElement('li');
      li.className = 'insight-rec';
      li.textContent = esc(recommendation.summary);
      recList.appendChild(li);
    }
    const recHead = document.createElement('p');
    recHead.className = 'insight-label';
    recHead.textContent = 'Suggestions for Engineer Mode:';
    parts.push(recHead, recList);
  }

  if (!parts.length) {
    container.dataset.state = 'unavailable';
    container.textContent = 'Analysis complete. No notable issues detected.';
    return;
  }

  container.replaceChildren(...parts);
}

/**
 * Manages a single analysis session for the landing page.
 * Call `analyze(channels, sampleRate, options)` after each new stem pair.
 * The analysis runs off-main-thread (FullAnalysisHost → FullAnalysisWorker).
 */
export class AnalysisInsightsUI {
  /**
   * @param {Element} container - DOM container for the insights panel
   * @param {object} [options]
   * @param {string} [options.analysisVersion] - version token for cache keying
   */
  constructor(container, { analysisVersion = '1' } = {}) {
    this.container = container;
    this.analysisVersion = analysisVersion;
    this._host = new FullAnalysisHost({ useWorker: true, enableMlVad: true });
    this._coordinator = new AnalysisCoordinator({
      analyze: (input, opts) => this._host.analyze(input.channels, input.sampleRate, opts),
    });
    this._seq = 0;
    this._controller = null;
  }

  /**
   * Start an analysis pass on the given channel data.
   * If a prior analysis is in flight it is cancelled; the UI is not updated
   * until the new result is ready (non-blocking, fire-and-forget from the
   * caller's perspective).
   *
   * @param {Float32Array[]} channels
   * @param {number} sampleRate
   * @param {object} [options]
   * @param {string} [options.contentFingerprint] - stable ID for the source audio
   * @param {string} [options.backend] - 'wasm' or 'webgpu'
   */
  async analyze(channels, sampleRate, { contentFingerprint = 'unknown', backend = 'wasm' } = {}) {
    // Cancel any in-flight pass.
    this._controller?.abort();
    const controller = new AbortController();
    this._controller = controller;
    const seq = ++this._seq;

    if (this.container) {
      this.container.dataset.state = 'pending';
      this.container.textContent = 'Analysing on-device…';
    }

    try {
      const identity = coordIdentity(contentFingerprint, this.analysisVersion, backend);
      const snapshot = await this._coordinator.analyze(
        identity,
        { channels, sampleRate },
        { signal: controller.signal },
      );

      if (seq !== this._seq || controller.signal.aborted) return;

      // Convert the raw FullAnalysis result to a validated AnalysisSnapshot,
      // then run all three supported goal recommendations.
      const validatedSnapshot = toSnapshot(snapshot, {
        contentFingerprint,
        analysisVersion: this.analysisVersion,
        backend,
      });

      const recommendations = SUPPORTED_GOALS.map((goal) => {
        try {
          return recommendForGoal(validatedSnapshot, goal, { previewAvailable: false });
        } catch {
          return null;
        }
      }).filter(Boolean);

      if (seq !== this._seq) return;
      if (this.container) renderInsights(this.container, { snapshot: validatedSnapshot, recommendations });
    } catch (err) {
      if (seq !== this._seq) return;
      if (err?.name === 'AbortError' || err?.name === 'CancellationError') return;
      console.warn('[VIP][AnalysisInsightsUI] Analysis failed (non-fatal):', err);
      if (this.container) {
        this.container.dataset.state = 'failed';
        this.container.textContent = 'On-device analysis unavailable for this file.';
      }
    }
  }

  /** Cancel any in-flight analysis and reset the panel to its idle state. */
  reset() {
    this._controller?.abort();
    this._coordinator.clear();
    this._seq = 0;
    if (this.container) {
      this.container.dataset.state = 'unavailable';
      this.container.textContent = 'Source confidence appears after on-device analysis. No placeholder measurements.';
    }
  }

  /** Release the underlying worker. */
  dispose() {
    this._controller?.abort();
    this._host.dispose();
  }
}

export default AnalysisInsightsUI;
