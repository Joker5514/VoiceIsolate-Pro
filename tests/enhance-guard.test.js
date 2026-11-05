/**
 * tests/enhance-guard.test.js
 *
 * VIP-005 (IMPLEMENTATION_READINESS_AUDIT_2026-11-02): the Enhance Speech
 * (DeepFilterNet3) suitability guard. The catastrophic cases these signals
 * stand in for are reproduced by scripts/quality/quality-matrix.cjs:
 *   whisper-clean/enhance SI-SDR out −16.5 dB (speech-level Δ −31.2 dB)
 *   babble-0db/enhance    SI-SDR delta −17.2 dB
 *   clipped/enhance       SI-SDR out −5.4 dB
 * These tests pin the ROUTING that keeps those chains off unsuitable content;
 * the pinned quality-gate metrics catch the model getting worse.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let guard;

beforeAll(async () => {
  guard = await import('../src/core/EnhanceGuard.js');
});

/** Whisper-dominant analysis (fixture-shaped: confident whisper regions). */
function whisperAnalysis(overrides = {}) {
  return {
    duration: 60,
    snrDb: 12,
    speechRatio: 0.6,
    speechSegments: [{ start: 0, end: 30 }, { start: 35, end: 60 }],
    whisperCandidates: [
      { start: 0, end: 10, confidence: 0.9 },
      { start: 35, end: 55, confidence: 0.8 },
    ],
    ...overrides,
  };
}

describe('evaluateEnhanceSuitability', () => {
  test('confidently whisper-dominant content is unsuitable for auto-enhance', () => {
    const v = guard.evaluateEnhanceSuitability(whisperAnalysis(), { durationSec: 60 });
    expect(v.suitability).toBe(guard.ENHANCE_SUITABILITY.UNSUITABLE);
    expect(v.reason).toMatch(/whisper/i);
    expect(v.fallbackOutcome).toBe(guard.FALLBACK_OUTCOME_ID);
    expect(v.signals.whisperRatio).toBeGreaterThan(0.4);
  });

  test('low-SNR content is uncertain (babble/clipped classes match, cause unnamed)', () => {
    const v = guard.evaluateEnhanceSuitability({
      duration: 60, snrDb: -1.8, speechRatio: 0.6,
      speechSegments: [{ start: 0, end: 60 }], whisperCandidates: [],
    }, { durationSec: 60 });
    expect(v.suitability).toBe(guard.ENHANCE_SUITABILITY.UNCERTAIN);
    expect(v.reason).toMatch(/low SNR/);
    expect(v.reason).toMatch(/uncertain/i);
    expect(v.fallbackOutcome).toBe(guard.FALLBACK_OUTCOME_ID);
  });

  test('sparse-speech content is uncertain', () => {
    const v = guard.evaluateEnhanceSuitability({
      duration: 60, snrDb: 20, speechRatio: 0.1,
      speechSegments: [{ start: 0, end: 6 }], whisperCandidates: [],
    }, { durationSec: 60 });
    expect(v.suitability).toBe(guard.ENHANCE_SUITABILITY.UNCERTAIN);
    expect(v.reason).toMatch(/sparse speech/);
  });

  test('some confident whisper below the block ratio is still uncertain', () => {
    const v = guard.evaluateEnhanceSuitability({
      duration: 120, snrDb: 15, speechRatio: 0.7,
      speechSegments: [{ start: 0, end: 100 }],
      whisperCandidates: [{ start: 0, end: 5, confidence: 0.9 }],
    }, { durationSec: 120 });
    expect(v.suitability).toBe(guard.ENHANCE_SUITABILITY.UNCERTAIN);
    expect(v.reason).toMatch(/whisper regions/);
  });

  test('clean speech with healthy SNR is suitable but never claims universal safety', () => {
    const v = guard.evaluateEnhanceSuitability({
      duration: 60, snrDb: 20, speechRatio: 0.8,
      speechSegments: [{ start: 0, end: 50 }], whisperCandidates: [],
    }, { durationSec: 60 });
    expect(v.suitability).toBe(guard.ENHANCE_SUITABILITY.SUITABLE);
    expect(v.reason).toMatch(/not a guarantee/i);
    expect(v.fallbackOutcome).toBeNull();
  });

  test('no analysis never blocks and never claims safety', () => {
    for (const analysis of [null, undefined, {}, 'nonsense', 42]) {
      const v = guard.evaluateEnhanceSuitability(analysis);
      expect(v.suitability).toBe(guard.ENHANCE_SUITABILITY.SUITABLE);
      expect(v.reason).toMatch(/hazard is documented|No analysis/i);
      expect(v.fallbackOutcome).toBeNull();
    }
  });

  test('malformed regions are tolerated (no crash, no fake whisper)', () => {
    const v = guard.evaluateEnhanceSuitability({
      duration: 10, snrDb: 20, speechRatio: 0.9,
      speechSegments: [{ start: 5, end: 1 }, { start: NaN, end: 3 }, null],
      whisperCandidates: [{ start: 'x', end: 'y' }, { end: 2 }],
    }, { durationSec: 10 });
    expect(v.signals.whisperRatio).toBe(0);
    expect(v.suitability).toBe(guard.ENHANCE_SUITABILITY.SUITABLE);
  });

  test('AnalysisSnapshot shape (evidenceRegions + measurements) is understood', () => {
    const v = guard.evaluateEnhanceSuitability({
      measurements: { snrDb: -2, speechRatio: 0.5 },
      evidenceRegions: [
        { startTime: 0, endTime: 20, detectionType: 'whisper', confidence: 0.9 },
        { startTime: 20, endTime: 40, detectionType: 'speech', confidence: 0.9 },
      ],
    }, { durationSec: 60 });
    expect(v.signals.hasAnalysis).toBe(true);
    expect(v.signals.whisperRatio).toBeGreaterThan(0);
    expect(['unsuitable', 'uncertain']).toContain(v.suitability);
  });

  test('explicit override keeps the verdict but makes it advisory-only', () => {
    const v = guard.evaluateEnhanceSuitability(whisperAnalysis(), { durationSec: 60, explicit: true });
    expect(v.suitability).toBe(guard.ENHANCE_SUITABILITY.UNSUITABLE); // verdict unchanged
    expect(v.advisoryOnly).toBe(true);
    expect(v.fallbackOutcome).toBeNull(); // caller must NOT auto-switch
  });
});

describe('guardEnhanceOutcome', () => {
  test('non-enhance outcomes pass through untouched', () => {
    for (const id of ['bsrnn_vocals', 'max_isolation', 'rnnoise', 'other']) {
      const r = guard.guardEnhanceOutcome(id, whisperAnalysis(), { durationSec: 60 });
      expect(r).toEqual({ outcome: id, changed: false, verdict: null, message: null });
    }
  });

  test('enhance on whisper-dominant content auto-switches to the fallback with an explanation', () => {
    const r = guard.guardEnhanceOutcome(guard.ENHANCE_OUTCOME_ID, whisperAnalysis(), { durationSec: 60 });
    expect(r.changed).toBe(true);
    expect(r.outcome).toBe('bsrnn_vocals');
    expect(r.message).toMatch(/whisper/i);
  });

  test('enhance on uncertain content falls back conservatively', () => {
    const r = guard.guardEnhanceOutcome('enhance_speech', {
      duration: 60, snrDb: -2, speechRatio: 0.6,
      speechSegments: [{ start: 0, end: 60 }], whisperCandidates: [],
    }, { durationSec: 60 });
    expect(r.changed).toBe(true);
    expect(r.outcome).toBe('bsrnn_vocals');
  });

  test('explicit post-warning override is honored with an advisory message', () => {
    const r = guard.guardEnhanceOutcome('enhance_speech', whisperAnalysis(), { durationSec: 60, explicit: true });
    expect(r.changed).toBe(false);
    expect(r.outcome).toBe('enhance_speech');
    expect(r.message).toMatch(/Heads-up/);
  });

  test('explicit override on suitable content is silent', () => {
    const r = guard.guardEnhanceOutcome('enhance_speech', {
      duration: 60, snrDb: 20, speechRatio: 0.8,
      speechSegments: [{ start: 0, end: 50 }], whisperCandidates: [],
    }, { durationSec: 60, explicit: true });
    expect(r.changed).toBe(false);
    expect(r.message).toBeNull();
  });
});

describe('Landing wiring (VIP-005 regression pin)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'landing.js'), 'utf8');

  test('landing applies the guard at analysis completion, at outcome change, and before Process', () => {
    expect(src).toMatch(/from '\/src\/core\/EnhanceGuard\.js'/);
    // VIP-032 + Arena follow-up: EnhanceGuard must consume the canonical
    // AnalysisSnapshot, so the pin requires the snapshot form — a bare
    // `analysisResult` assignment no longer passes. The `|| analysisResult`
    // fallback in landing itself stays (legacy results still degrade
    // gracefully), but the test no longer blesses the old form.
    expect(src).toMatch(/enhanceGuard\.analysis = analysisResult\.snapshot \|\| analysisResult;[\s\S]{0,120}applyEnhanceGuard\(\)/);
    expect(src).toMatch(/applyEnhanceGuard\(\);\s*processPlan = quickClean\.plan\(\)/);
    expect(src).toMatch(/resetEnhanceGuard\(\)/);
  });

  test('the documented default outcome never auto-selects enhance', () => {
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const selected = html.match(/<option value="([^"]+)"[^>]*selected/);
    expect(selected && selected[1]).toBe('bsrnn_vocals');
    expect(src).not.toMatch(/modelSelect\.value\s*=\s*['"]enhance_speech['"]/);
  });

  test('whisper retention meter shows unmeasured state instead of a fabricated default', () => {
    const meters = fs.readFileSync(path.join(ROOT, 'src', 'ui', 'components', 'LiveMeters', 'LiveMeters.js'), 'utf8');
    expect(meters).not.toMatch(/whisperRetention \?\? 85/);
    expect(meters).toMatch(/whisperRetention \?\? null/);
  });
});
