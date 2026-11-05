/**
 * VoiceIsolate Pro — Enhance Speech suitability guard (Layer 1: Core)
 *
 * VIP-005 (IMPLEMENTATION_READINESS_AUDIT_2026-11-02). DeepFilterNet3
 * ("Enhance Speech") is measurably catastrophic on whisper content and on
 * some low-SNR material — reproduced on the pinned quality fixtures:
 *
 *   whisper-clean/enhance      SI-SDR out −16.5 dB, speech-level Δ −31.2 dB
 *   whisper-white-10db/enhance SI-SDR delta −7.4 dB
 *   babble-0db/enhance         SI-SDR delta −17.2 dB
 *   clipped/enhance            SI-SDR out −5.4 dB
 *
 * (scripts/quality/quality-matrix.cjs — synthetic proxies; the speech-level
 * figure is the energy crush, not a fricative metric.)
 *
 * This module decides, from **existing analysis signals only**, whether the
 * DeepFilterNet3 chain is a safe *automatic* choice. It is pure and honest
 * about uncertainty:
 *
 *   - 'unsuitable'   — analysis confidently flags substantial whisper content.
 *                      The enhance chain must not be applied automatically.
 *   - 'uncertain'    — analysis found signals associated with the reproduced
 *                      failure classes (low SNR, dominant non-speech, sparse
 *                      speech) but cannot name the cause (the analyser does
 *                      not detect "babble" as a class). Conservative fallback.
 *   - 'suitable'     — nothing in the analysis matches the failure classes.
 *   *                      This is NOT a claim that enhancement never degrades
 *                      speech; it is "no known hazard detected".
 *
 * An explicit, informed user choice always wins: callers pass
 * `{ explicit: true }` and the verdict is advisory-only. Overrides must be
 * reversible (the user can select another outcome at any time).
 *
 * Pure module: no DOM, no Web Audio, no I/O.
 */
'use strict';

export const ENHANCE_SUITABILITY = Object.freeze({
  SUITABLE: 'suitable',
  UNSUITABLE: 'unsuitable',
  UNCERTAIN: 'uncertain',
});

/** The chain this guard governs. */
export const ENHANCE_MODEL_IDS = Object.freeze(['deepfilternet3']);

/** Outcome id (Landing Quick Clean) that selects the enhance chain. */
export const ENHANCE_OUTCOME_ID = 'enhance_speech';

/** Conservative fallback outcome when enhance is not safe to apply. */
export const FALLBACK_OUTCOME_ID = 'bsrnn_vocals';

const DEFAULTS = Object.freeze({
  // Share of analysed speech time flagged as whisper that blocks auto-enhance.
  whisperRatioBlock: 0.15,
  // Any confident whisper region at all raises at least 'uncertain'.
  whisperConfidenceMin: 0.5,
  // Below this SNR (dB) the reproduced failure classes (babble-like, clipped,
  // noisy) become likely and the analyser cannot name the cause.
  snrUncertainDb: 6,
  // Speech below this share of the file means the dominant content is
  // non-speech (music/environment) — the class enhance handles worst.
  speechRatioUncertain: 0.25,
});

/**
 * Sum of region durations, tolerant of missing/malformed entries.
 * @param {Array<{start:number, end:number, confidence?: number}>} regions
 */
function durationOf(regions) {
  if (!Array.isArray(regions)) return 0;
  let total = 0;
  for (const r of regions) {
    const start = Number(r?.start ?? r?.startTime);
    const end = Number(r?.end ?? r?.endTime);
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      total += end - start;
    }
  }
  return total;
}

/**
 * Evaluate whether the DeepFilterNet3 chain is safe to apply automatically.
 *
 * Accepted `analysis` shapes (whichever the caller has):
 *  - AutoAnalysis result: { whisperCandidates, speechSegments, speechRatio, snrDb }
 *  - AnalysisSnapshot:    { evidenceRegions, measurements } — whisper regions
 *    via detectionType 'whisper'/'whisper_candidate', measurements.snrDb/speechRatio
 *
 * @param {object|null} analysis
 * @param {object} [options]
 * @param {number} [options.durationSec] total duration when regions are relative
 * @param {boolean} [options.explicit]  user explicitly chose enhance (advisory only)
 * @param {typeof DEFAULTS} [options.thresholds]
 * @returns {{suitability:'suitable'|'unsuitable'|'uncertain', reason:string,
 *            whisperRatio:number, signals:object, fallbackOutcome:string|null,
 *            advisoryOnly:boolean}}
 */
export function evaluateEnhanceSuitability(analysis, options = {}) {
  const t = { ...DEFAULTS, ...(options.thresholds || {}) };
  const explicit = options.explicit === true;
  const signals = {
    whisperRatio: 0,
    whisperConfident: false,
    snrDb: null,
    speechRatio: null,
    hasAnalysis: false,
  };
  const base = {
    signals,
    whisperRatio: 0,
    fallbackOutcome: null,
    advisoryOnly: explicit,
  };

  if (!analysis || typeof analysis !== 'object') {
    // No analysis: never claim suitability — but never block either. The
    // caller's own UX (warnings) carries the known DFN3/whisper hazard.
    return {
      ...base,
      suitability: ENHANCE_SUITABILITY.SUITABLE,
      reason: 'No analysis available; enhance is allowed but its known whisper hazard is documented in the outcome description.',
    };
  }
  signals.hasAnalysis = true;

  // ── Whisper signal (both shapes) ─────────────────────────────────────────
  const whisperRegions = [
    ...(Array.isArray(analysis.whisperCandidates) ? analysis.whisperCandidates : []),
    ...(Array.isArray(analysis.evidenceRegions)
      ? analysis.evidenceRegions.filter((r) => /whisper/i.test(String(r?.detectionType)))
      : []),
  ];
  const speechRegions = [
    ...(Array.isArray(analysis.speechSegments) ? analysis.speechSegments : []),
    ...(Array.isArray(analysis.evidenceRegions)
      ? analysis.evidenceRegions.filter((r) => r?.detectionType === 'speech')
      : []),
  ];
  const duration = Number(options.durationSec)
    || durationOf(speechRegions) + durationOf(whisperRegions)
    || Number(analysis.duration ?? analysis.input?.durationSeconds) || 0;

  const whisperSec = durationOf(whisperRegions);
  const speechSec = durationOf(speechRegions) || Math.max(whisperSec, 0);
  // Whisper share of *speech* time when known, else of total time.
  const whisperRatio = speechSec > 0 ? Math.min(1, whisperSec / speechSec)
    : (duration > 0 ? Math.min(1, whisperSec / duration) : 0);
  signals.whisperRatio = whisperRatio;
  // "Confident" needs a real confidence value at or above the threshold (or
  // canonical EvidenceRegion certainty of medium/high) — malformed or
  // confidence-less regions never block the expert path.
  signals.whisperConfident = whisperRegions.some((r) => {
    const c = Number(r?.confidence ?? r?.evidence?.confidence);
    if (Number.isFinite(c)) return c >= t.whisperConfidenceMin;
    return r?.certainty === 'high' || r?.certainty === 'medium';
  });

  // ── Uncertainty signals (both shapes) ────────────────────────────────────
  const snrDb = Number(analysis.snrDb ?? analysis.measurements?.snrDb);
  const speechRatio = Number(analysis.speechRatio ?? analysis.measurements?.speechRatio);
  signals.snrDb = Number.isFinite(snrDb) ? snrDb : null;
  signals.speechRatio = Number.isFinite(speechRatio) ? speechRatio : null;

  // No usable signal at all (e.g. `{}` or garbage): same honesty rule as a
  // missing analysis — allow, never claim suitability, document the hazard.
  if (whisperSec === 0 && !signals.whisperConfident
    && signals.snrDb === null && signals.speechRatio === null) {
    return {
      ...base,
      suitability: ENHANCE_SUITABILITY.SUITABLE,
      reason: 'No analysis signals available; enhance is allowed but its known whisper hazard is documented in the outcome description.',
    };
  }

  // ── Verdict (ordered: block > uncertain > suitable) ──────────────────────
  if (signals.whisperConfident && whisperRatio >= t.whisperRatioBlock) {
    return {
      ...base,
      whisperRatio,
      suitability: ENHANCE_SUITABILITY.UNSUITABLE,
      reason: `Analysis flags ${(whisperRatio * 100).toFixed(0)}% of speech as whispered; DeepFilterNet3 is known to suppress whispers (pinned quality fixtures).`,
      fallbackOutcome: explicit ? null : FALLBACK_OUTCOME_ID,
    };
  }
  const uncertainReasons = [];
  if (whisperSec > 0) uncertainReasons.push('some whisper regions detected');
  if (signals.snrDb !== null && signals.snrDb < t.snrUncertainDb) uncertainReasons.push(`low SNR (${signals.snrDb.toFixed(1)} dB)`);
  if (signals.speechRatio !== null && signals.speechRatio < t.speechRatioUncertain) uncertainReasons.push(`sparse speech (${(signals.speechRatio * 100).toFixed(0)}% of the file)`);
  if (uncertainReasons.length) {
    return {
      ...base,
      whisperRatio,
      suitability: ENHANCE_SUITABILITY.UNCERTAIN,
      reason: `Enhancement outcome is uncertain (${uncertainReasons.join('; ')}). These conditions match inputs where DeepFilterNet3 degraded speech in testing; falling back to Clean Speech is safer.`,
      fallbackOutcome: explicit ? null : FALLBACK_OUTCOME_ID,
    };
  }
  return {
    ...base,
    whisperRatio,
    suitability: ENHANCE_SUITABILITY.SUITABLE,
    reason: 'No whisper or low-confidence hazard detected. This is not a guarantee: enhancement can still degrade some material.',
  };
}

/**
 * Guard one outcome choice. Non-enhance outcomes pass through unchanged.
 *
 * @param {string} outcomeId  e.g. 'enhance_speech'
 * @param {object|null} analysis
 * @param {object} [options] see evaluateEnhanceSuitability; `{ explicit: true }`
 *   marks an informed user choice (verdict becomes advisory).
 * @returns {{outcome:string, changed:boolean, verdict:object|null, message:string|null}}
 */
export function guardEnhanceOutcome(outcomeId, analysis, options = {}) {
  if (outcomeId !== ENHANCE_OUTCOME_ID) {
    return { outcome: outcomeId, changed: false, verdict: null, message: null };
  }
  const verdict = evaluateEnhanceSuitability(analysis, options);
  if (verdict.suitability === ENHANCE_SUITABILITY.SUITABLE || options.explicit === true) {
    return {
      outcome: outcomeId,
      changed: false,
      verdict,
      message: verdict.suitability === ENHANCE_SUITABILITY.SUITABLE ? null
        : `Heads-up: ${verdict.reason}`,
    };
  }
  return {
    outcome: verdict.fallbackOutcome || FALLBACK_OUTCOME_ID,
    changed: true,
    verdict,
    message: verdict.reason,
  };
}

export default { evaluateEnhanceSuitability, guardEnhanceOutcome, ENHANCE_SUITABILITY, ENHANCE_MODEL_IDS, ENHANCE_OUTCOME_ID, FALLBACK_OUTCOME_ID };
