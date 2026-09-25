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
import { adaptFullAnalysisToSnapshot } from '../core/AnalysisSnapshotAdapter.js';

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
  const document = container.ownerDocument;
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
    // The coordinator validates canonical snapshots, so the raw FullAnalysis
    // result is adapted inside the analysis callback, not after it.
    this._coordinator = new AnalysisCoordinator({
      analyze: async (input, opts) => adaptFullAnalysisToSnapshot(
        await this._host.analyze(input.channels, input.sampleRate, { signal: opts.signal }),
        {
          contentFingerprint: input.contentFingerprint,
          analysisVersion: this.analysisVersion,
          versions: { runtime: input.backend },
        },
      ),
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
  async analyze(channels, sampleRate, { contentFingerprint, backend = 'wasm' } = {}) {
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
      // A missing fingerprint must not collapse different files onto one
      // cache entry; the coordinator bypasses its cache for such requests.
      const fingerprint = contentFingerprint && contentFingerprint !== 'unknown' ? contentFingerprint : undefined;
      const identity = coordIdentity(fingerprint, this.analysisVersion, backend);
      const validatedSnapshot = await this._coordinator.analyze(
        identity,
        { channels, sampleRate, contentFingerprint: fingerprint, backend },
        { signal: controller.signal },
      );

      if (seq !== this._seq || controller.signal.aborted) return;

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
