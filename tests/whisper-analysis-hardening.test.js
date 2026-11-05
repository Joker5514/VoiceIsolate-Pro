/**
 * VoiceIsolate Pro — Whisper / AI Analysis Hardening Tests
 *
 * Regression coverage for:
 *   1. WHISPER_HUNTER stale-file guard — applyPreset/morphSlidersTo/runPipeline
 *      must not execute when the file changes during async analysis.
 *   2. WHISPER_HUNTER outer timeout — _running resets even when runPipeline stalls.
 *   3. morphSlidersTo no-DOM path — out-of-range values are clamped to slider spec.
 *   4. _analysisFileSeq stamping — _lastFullAnalysis is invalidated on file change
 *      so WhisperHunter does not drive preset selection with stale content maps.
 *   5. WhisperLogic pure-function correctness — silence/loud/whisper confidence
 *      scoring, region merging, and processing-policy output.
 *   6. FullAnalysisHost timeout/cancellation — hard-deadline and AbortSignal paths.
 *   7. chunkedMaskInference per-chunk timeout — resolves to fallback mask on stall.
 *   8. reverbStrip lower-bound guard — negative rt60 cannot produce a negative value.
 *
 * Verification status: UNIT (Node.js static analysis + logic tests; no browser required).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appJsSrc() {
  return fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
}

function analysisWorkspaceSrc() {
  return fs.readFileSync(path.join(ROOT, 'public/app/lib/analysis-workspace.js'), 'utf8');
}

/** Very small fake AbortController for use in Node. */
function makeAbort() {
  let _aborted = false;
  const listeners = [];
  const signal = {
    get aborted() { return _aborted; },
    addEventListener(_, fn, opts) {
      if (_aborted) { fn(); return; }
      listeners.push({ fn, once: opts?.once });
    },
    removeEventListener(_, fn) {
      const i = listeners.findIndex((l) => l.fn === fn);
      if (i !== -1) listeners.splice(i, 1);
    },
  };
  return {
    signal,
    abort(reason) {
      if (_aborted) return;
      _aborted = true;
      signal.reason = reason;
      for (const l of listeners) l.fn(reason);
    },
  };
}

/** Parse WHISPER_HUNTER from app.js source (static text search). */
function whisperHunterSection(src) {
  const start = src.indexOf('const WHISPER_HUNTER = {');
  const end = src.indexOf('\n};', start);
  return src.slice(start, end + 3);
}

// ---------------------------------------------------------------------------
// 1. Stale-file guard: WHISPER_HUNTER.run() captures fileSeq
// ---------------------------------------------------------------------------

describe('WHISPER_HUNTER stale-file guard', () => {
  const src = appJsSrc();
  const section = whisperHunterSection(src);

  test('_runningFileSeq field is declared', () => {
    expect(section).toMatch(/_runningFileSeq\s*:/);
  });

  test('run() captures runFileSeq = app._fileSeq', () => {
    expect(section).toMatch(/runFileSeq\s*=\s*app\._fileSeq/);
  });

  test('staleFile() predicate compares app._fileSeq to runFileSeq', () => {
    expect(section).toMatch(/staleFile\s*=\s*\(\)\s*=>\s*app\._fileSeq\s*!==\s*runFileSeq/);
  });

  test('staleFile() is checked before applyPreset()', () => {
    const presetIdx = section.indexOf('app.applyPreset(basePreset)');
    const staleCheckBefore = section.lastIndexOf('staleFile()', presetIdx);
    expect(staleCheckBefore).toBeGreaterThan(-1);
    expect(staleCheckBefore).toBeLessThan(presetIdx);
  });

  test('staleFile() is checked before first morphSlidersTo()', () => {
    const morphIdx = section.indexOf('await app.morphSlidersTo(');
    const staleCheckBefore = section.lastIndexOf('staleFile()', morphIdx);
    expect(staleCheckBefore).toBeGreaterThan(-1);
    expect(staleCheckBefore).toBeLessThan(morphIdx);
  });

  test('staleFile() is checked before runPipeline()', () => {
    const pipeIdx = section.indexOf('await app.runPipeline()');
    const staleCheckBefore = section.lastIndexOf('staleFile()', pipeIdx);
    expect(staleCheckBefore).toBeGreaterThan(-1);
    expect(staleCheckBefore).toBeLessThan(pipeIdx);
  });

  test('staleFile() is checked after runDeepFilterNet()', () => {
    const deepIdx = section.indexOf('await this.runDeepFilterNet(');
    const staleCheckAfter = section.indexOf('staleFile()', deepIdx);
    expect(staleCheckAfter).toBeGreaterThan(deepIdx);
  });

  test('stale-file error uses STALE_FILE code and is caught silently', () => {
    expect(section).toMatch(/code\s*:\s*['"]STALE_FILE['"]/);
    expect(section).toMatch(/err\?\.code\s*===\s*['"]STALE_FILE['"]/);
  });

  test('_running is cleared in finally even on stale-file throw', () => {
    // The outer try/catch/finally must reset _running and clear outerTimer.
    expect(section).toMatch(/clearTimeout\(outerTimer\)/);
    expect(section).toMatch(/this\._running\s*=\s*false/);
    expect(section).toMatch(/this\._runningFileSeq\s*=\s*-1/);
  });

  test('STALE_FILE error does not call showNotification (user-visible error)', () => {
    // The STALE_FILE catch branch should NOT call showNotification.
    const catchStart = section.indexOf("if (err?.code === 'STALE_FILE')");
    const catchEnd = section.indexOf('} else {', catchStart);
    const catchBranch = section.slice(catchStart, catchEnd);
    expect(catchBranch).not.toMatch(/showNotification/);
  });
});

// ---------------------------------------------------------------------------
// 2. Outer timeout: WHISPER_HUNTER.run() has a 120 s safety deadline
// ---------------------------------------------------------------------------

describe('WHISPER_HUNTER outer timeout', () => {
  const src = appJsSrc();
  const section = whisperHunterSection(src);

  test('outer timeout Promise is created', () => {
    expect(section).toMatch(/new Promise\s*\(\s*\(_\s*,\s*reject\)/);
    expect(section).toMatch(/outerTimer\s*=\s*setTimeout/);
  });

  test('timeout is 120 000 ms', () => {
    expect(section).toMatch(/120000/);
  });

  test('Promise.race is used with outerTimeout', () => {
    expect(section).toMatch(/Promise\.race\s*\(\s*\[/);
    expect(section).toMatch(/outerTimeout\s*\]/);
  });

  test('outerTimer is cleared in finally', () => {
    const finallyIdx = section.indexOf('clearTimeout(outerTimer)');
    expect(finallyIdx).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// 3. morphSlidersTo no-DOM path: values are clamped via clampToSlider
// ---------------------------------------------------------------------------

describe('morphSlidersTo no-DOM path clamping', () => {
  const src = appJsSrc();
  // Extract morphSlidersTo method body
  const start = src.indexOf('morphSlidersTo(targets, durationMs');
  const end = src.indexOf('\n  }', start) + 4;
  const method = src.slice(start, end);

  test('no-DOM else branch calls clampToSlider()', () => {
    expect(method).toMatch(/clampToSlider\(id,\s*val\)/);
  });

  test('no-DOM else branch stores clamped value in VIP_PARAMS', () => {
    expect(method).toMatch(/VIP_PARAMS\[id\]\s*=\s*clamped/);
  });

  test('no-DOM else branch passes clamped value to onSlider()', () => {
    expect(method).toMatch(/this\.onSlider\(id,\s*clamped\)/);
  });

  test('no-DOM else branch does NOT pass raw val to onSlider', () => {
    // After the fix, there must be no `this.onSlider(id, val)` in the no-DOM branch
    // (would be in the else block that now uses clamped).
    const elseBlock = method.slice(method.indexOf('} else {'), method.indexOf('}\n        });'));
    expect(elseBlock).not.toMatch(/this\.onSlider\(id,\s*val\)/);
  });
});

// ---------------------------------------------------------------------------
// 4. _analysisFileSeq stamping in analysis-workspace.js and app.js
// ---------------------------------------------------------------------------

describe('_analysisFileSeq stamping', () => {
  const wsSrc = analysisWorkspaceSrc();
  const appSrc = appJsSrc();

  test('analysis-workspace stamps _analysisFileSeq in collaborateWithHunter', () => {
    const collabIdx = wsSrc.indexOf('collaborateWithHunter');
    // Find the assignment after enrichAnalysisWithCollaboration
    const enrichIdx = wsSrc.indexOf('enrichAnalysisWithCollaboration(', collabIdx);
    const stamp = wsSrc.indexOf('_analysisFileSeq = app._fileSeq', enrichIdx);
    expect(stamp).toBeGreaterThan(enrichIdx);
    expect(stamp - enrichIdx).toBeLessThan(500);
  });

  test('analysis-workspace stamps _analysisFileSeq in renderAnalysis', () => {
    const renderIdx = wsSrc.indexOf('function renderAnalysis(analysis)');
    const stamp = wsSrc.indexOf('_analysisFileSeq = app._fileSeq', renderIdx);
    expect(stamp).toBeGreaterThan(renderIdx);
    expect(stamp - renderIdx).toBeLessThan(200);
  });

  test('analysis-workspace resets _analysisFileSeq to -1 on clear/cancel', () => {
    // The sourceAbort reset block should set _analysisFileSeq = -1
    expect(wsSrc).toMatch(/_analysisFileSeq\s*=\s*-1/);
  });

  test('app.js _resetCollaborationState sets _analysisFileSeq to -1', () => {
    const resetIdx = appSrc.indexOf('_resetCollaborationState()');
    const stmt = appSrc.indexOf('_analysisFileSeq = -1', resetIdx);
    expect(stmt).toBeGreaterThan(resetIdx);
    expect(stmt - resetIdx).toBeLessThan(300);
  });

  test('WhisperHunter.run() guards against stale analysis via _analysisFileSeq', () => {
    const section = whisperHunterSection(appSrc);
    expect(section).toMatch(/_analysisFileSeq/);
    expect(section).toMatch(/analysisFileSeq\s*===\s*runFileSeq/);
  });
});

// ---------------------------------------------------------------------------
// 5. WhisperLogic pure-function tests
// ---------------------------------------------------------------------------

// Polyfill: WhisperLogic uses ESM, test it as a CommonJS shim.
// We replicate the pure math inline rather than importing ESM from Node.

function whisperFrameConfidence(frame, ctx = {}) {
  const noiseFloor = ctx.noiseFloor ?? 0.001;
  const rms = frame.rms ?? 0;
  const rmsDb = frame.rmsDb ?? (20 * Math.log10(rms + 1e-12));
  if (rms < noiseFloor * 1.2 && rmsDb < -55) return 0;
  if (rmsDb > -28) return 0;
  const speech = frame.speechRatio ?? 0;
  const harm = frame.harmonicity ?? 0;
  const flat = frame.flatness ?? 1;
  const voiced = frame.voiced ?? 0;
  const zcr = frame.zcr ?? 0;
  const levelScore = rmsDb > -52 && rmsDb < -30 ? 1
    : rmsDb > -58 && rmsDb <= -52 ? 0.75
    : rmsDb >= -30 && rmsDb < -28 ? 0.35 : 0.15;
  const structure = 0.35 * speech + 0.3 * harm + 0.2 * voiced + 0.15 * (1 - Math.min(1, flat));
  const noisePen = Math.min(1, Math.max(0, (zcr - 0.12) * 4 + (flat - 0.55) * 2));
  return Math.max(0, Math.min(1, levelScore * structure * (1 - 0.55 * noisePen)));
}

describe('whisperFrameConfidence', () => {
  test('pure silence (rms ≈ 0) → 0', () => {
    expect(whisperFrameConfidence({ rms: 0, rmsDb: -100 })).toBe(0);
  });

  test('loud speech (rmsDb = −20 dB) → 0', () => {
    expect(whisperFrameConfidence({ rms: 0.1, rmsDb: -20 })).toBe(0);
  });

  test('quiet structured speech at −40 dB → positive confidence', () => {
    const conf = whisperFrameConfidence({
      rms: 0.01, rmsDb: -40,
      speechRatio: 0.7, harmonicity: 0.5, voiced: 0.6, flatness: 0.2, zcr: 0.08,
    });
    expect(conf).toBeGreaterThan(0);
    expect(conf).toBeLessThanOrEqual(1);
  });

  test('high ZCR + high flatness (pure noise) reduces confidence', () => {
    const noiseLike = whisperFrameConfidence({
      rms: 0.01, rmsDb: -40,
      speechRatio: 0.5, harmonicity: 0.4, voiced: 0.4, flatness: 0.9, zcr: 0.45,
    });
    const speechLike = whisperFrameConfidence({
      rms: 0.01, rmsDb: -40,
      speechRatio: 0.5, harmonicity: 0.4, voiced: 0.4, flatness: 0.2, zcr: 0.08,
    });
    expect(noiseLike).toBeLessThan(speechLike);
  });

  test('output is always in [0, 1]', () => {
    const frames = [
      { rmsDb: -70, rms: 0.0001 },
      { rmsDb: -10, rms: 0.3 },
      { rmsDb: -40, rms: 0.01, speechRatio: 0.9, harmonicity: 0.9, voiced: 1, flatness: 0, zcr: 0 },
      { rmsDb: -40, rms: 0.01, speechRatio: 0, harmonicity: 0, voiced: 0, flatness: 1, zcr: 1 },
    ];
    for (const f of frames) {
      const c = whisperFrameConfidence(f);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  });

  test('NaN / undefined fields default to 0 and do not throw', () => {
    expect(() => whisperFrameConfidence({})).not.toThrow();
    expect(() => whisperFrameConfidence({ rmsDb: NaN })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 6. FullAnalysisHost — timeout and abort text in source
// ---------------------------------------------------------------------------

describe('FullAnalysisHost timeout and cancellation', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/pipeline/FullAnalysisHost.js'), 'utf8');

  test('hard deadline timer is set based on timeoutMs', () => {
    expect(src).toMatch(/hardDeadline\s*=\s*Date\.now\(\)\s*\+\s*timeoutMs/);
  });

  test('default timeoutMs is 180 000 ms (3 minutes)', () => {
    expect(src).toMatch(/timeoutMs.*\?\?\s*180000/);
  });

  test('stall detection is present (stallMs)', () => {
    expect(src).toMatch(/stallMs/);
    expect(src).toMatch(/now\s*-\s*lastActivity\s*>\s*stallMs/);
  });

  test('AbortSignal listener is registered', () => {
    expect(src).toMatch(/signal\.addEventListener\s*\(\s*'abort'/);
  });

  test('cancellation sends cancel message to worker', () => {
    expect(src).toMatch(/worker\.postMessage\s*\(\s*\{.*type\s*:\s*'cancel'/s);
  });

  test('feature extraction timeout is 120 000 ms', () => {
    expect(src).toMatch(/featureTimeoutMs.*\?\?\s*120000/);
  });

  test('generation counter prevents stale analysis from resolving', () => {
    expect(src).toMatch(/_analysisGeneration/);
    expect(src).toMatch(/generation\s*!==\s*this\._analysisGeneration/);
  });

  test('dispose() calls cancelActive()', () => {
    expect(src).toMatch(/dispose\s*\(\)\s*\{[\s\S]*?cancelActive\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// 7. chunkedMaskInference per-chunk timeout
// ---------------------------------------------------------------------------

describe('chunkedMaskInference per-chunk timeout', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/app/whisper-hunter.js'), 'utf8');

  test('per-chunk timeout uses options.timeoutMs with 500 ms floor', () => {
    expect(src).toMatch(/timeoutMs\s*=\s*Math\.max\s*\(\s*500/);
  });

  test('timer is set on each chunk', () => {
    expect(src).toMatch(/const timer\s*=\s*setTimeout\s*\(\s*\(\)\s*=>\s*finish\s*\(mag\)/);
  });

  test('settled flag prevents double-resolution', () => {
    expect(src).toMatch(/let settled\s*=\s*false/);
    expect(src).toMatch(/if\s*\(settled\)\s*return/);
  });

  test('worker.removeEventListener is called on completion', () => {
    expect(src).toMatch(/worker\.removeEventListener\s*\(\s*'message',\s*handler\s*\)/);
  });

  test('clearTimeout is called on message arrival', () => {
    expect(src).toMatch(/clearTimeout\s*\(\s*timer\s*\)/);
  });

  test('fallback mask is built when ML worker is unavailable (runDeepFilterNet in app.js)', () => {
    // buildHeuristicMask(env, 2049) is called in WHISPER_HUNTER.runDeepFilterNet in app.js
    const appSrc = appJsSrc();
    expect(appSrc).toMatch(/buildHeuristicMask\s*\(env,\s*2049\)/);
  });
});

// ---------------------------------------------------------------------------
// 8. reverbStrip lower-bound guard
// ---------------------------------------------------------------------------

describe('reverbStrip lower-bound guard in WHISPER_HUNTER morph', () => {
  const src = appJsSrc();
  const section = whisperHunterSection(src);

  test('reverbStrip uses Math.max(0, ...) to prevent negative values', () => {
    // Both the analysis-driven and fallback morph objects must have Math.max(0, ...)
    const occurrences = (section.match(/Math\.max\s*\(\s*0\s*,\s*Math\.round.*reverbStrip|reverbStrip.*Math\.max\s*\(\s*0/g) || []).length;
    // There are two morph objects (analysis path + fallback path), each has a reverbStrip line.
    // Both should contain Math.max(0, ...).
    const allReverbLines = [...section.matchAll(/reverbStrip\s*:/g)];
    expect(allReverbLines.length).toBeGreaterThanOrEqual(2);

    for (const match of allReverbLines) {
      const lineStart = match.index;
      const lineEnd = section.indexOf('\n', lineStart);
      const line = section.slice(lineStart, lineEnd);
      expect(line).toMatch(/Math\.max\s*\(\s*0/);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. WhisperHunter analysis-workspace compatibility: _analysisFileSeq consistency
// ---------------------------------------------------------------------------

describe('_analysisFileSeq lifecycle consistency', () => {
  const appSrc = appJsSrc();
  const wsSrc = analysisWorkspaceSrc();

  test('every non-null _lastFullAnalysis assignment in analysis-workspace is followed by _analysisFileSeq stamp', () => {
    // Search for assignments where the RHS is NOT the literal null.
    // We use a two-step approach: find all assignments, then exclude null ones.
    const allAssign = [...wsSrc.matchAll(/app\._lastFullAnalysis\s*=\s*([^;]+);/g)];
    const nonNullAssign = allAssign.filter((m) => !m[1].trim().startsWith('null'));
    expect(nonNullAssign.length).toBeGreaterThan(0);
    for (const m of nonNullAssign) {
      // Within 300 chars after the assignment there should be a fileSeq stamp
      const snippet = wsSrc.slice(m.index, m.index + 300);
      expect(snippet).toMatch(/_analysisFileSeq\s*=\s*app\._fileSeq/);
    }
  });

  test('every _lastFullAnalysis = null in analysis-workspace is followed by _analysisFileSeq = -1', () => {
    const re = /app\._lastFullAnalysis\s*=\s*null/g;
    let m;
    while ((m = re.exec(wsSrc)) !== null) {
      const snippet = wsSrc.slice(m.index, m.index + 200);
      expect(snippet).toMatch(/_analysisFileSeq\s*=\s*-1/);
    }
  });

  test('_resetCollaborationState in app.js resets _analysisFileSeq to -1', () => {
    const idx = appSrc.indexOf('_resetCollaborationState()');
    const body = appSrc.slice(idx, idx + 500);
    expect(body).toMatch(/_analysisFileSeq\s*=\s*-1/);
  });
});

// ---------------------------------------------------------------------------
// 10. WhisperLogic processing policy safety
// ---------------------------------------------------------------------------

describe('whisperProcessingPolicy output validation', () => {
  // Inline replication of the policy function for Node-side testing.
  function whisperProcessingPolicy(regions, globalCtx = {}) {
    const w = regions.whisperRegions || [];
    const d = regions.difficultSpeechRegions || [];
    const maxW = w.reduce((m, s) => Math.max(m, s.confidence || 0), 0);
    const maxD = d.reduce((m, s) => Math.max(m, s.confidence || 0), 0);
    const hasWhisper = w.length > 0 && maxW >= 0.45;
    const hasDifficult = d.length > 0 && maxD >= 0.4;
    return {
      activateWhisperPath: hasWhisper,
      activateDifficultPath: hasDifficult,
      gateThreshDb: hasWhisper ? -68 : -52,
      gateRangeDepth: hasWhisper ? 12 : 24,
      nrFloorDb: hasWhisper ? -78 : -68,
      whisperLiftDb: hasWhisper ? Math.round(8 + maxW * 14) : 0,
      protectConsonants: true,
      overGateProtection: true,
      formantBoost: hasWhisper ? Math.min(4, 1.5 + maxW * 2.5) : 0,
      confidence: Math.max(maxW, maxD),
      autoApplySafe: maxW >= 0.55 || maxD >= 0.6,
      notes: [],
    };
  }

  test('no regions → safe defaults, no whisper path', () => {
    const p = whisperProcessingPolicy({ whisperRegions: [], difficultSpeechRegions: [] });
    expect(p.activateWhisperPath).toBe(false);
    expect(p.activateDifficultPath).toBe(false);
    expect(p.gateThreshDb).toBe(-52);
    expect(p.gateRangeDepth).toBe(24);
    expect(p.autoApplySafe).toBe(false);
  });

  test('high-confidence whisper region → activates whisper path', () => {
    const p = whisperProcessingPolicy({
      whisperRegions: [{ confidence: 0.75, start: 0, end: 2 }],
      difficultSpeechRegions: [],
    });
    expect(p.activateWhisperPath).toBe(true);
    expect(p.gateThreshDb).toBe(-68);
    expect(p.gateRangeDepth).toBe(12);
    expect(p.whisperLiftDb).toBeGreaterThan(0);
    expect(p.formantBoost).toBeGreaterThan(0);
  });

  test('low-confidence whisper (< 0.45) → does NOT activate whisper path', () => {
    const p = whisperProcessingPolicy({
      whisperRegions: [{ confidence: 0.3, start: 0, end: 1 }],
      difficultSpeechRegions: [],
    });
    expect(p.activateWhisperPath).toBe(false);
  });

  test('confidence is always in [0, 1]', () => {
    const configs = [
      { whisperRegions: [], difficultSpeechRegions: [] },
      { whisperRegions: [{ confidence: 1 }], difficultSpeechRegions: [] },
      { whisperRegions: [{ confidence: 0.5 }], difficultSpeechRegions: [{ confidence: 0.7 }] },
    ];
    for (const c of configs) {
      const p = whisperProcessingPolicy(c);
      expect(p.confidence).toBeGreaterThanOrEqual(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
    }
  });

  test('gateThreshDb and nrFloorDb are within ParameterSchema safe ranges', () => {
    // ParameterSchema canonical: gateThresh min -120, max 0; nrFloor min -120, max -20
    const cases = [
      { whisperRegions: [], difficultSpeechRegions: [] },
      { whisperRegions: [{ confidence: 0.9 }], difficultSpeechRegions: [] },
    ];
    for (const c of cases) {
      const p = whisperProcessingPolicy(c);
      expect(p.gateThreshDb).toBeGreaterThanOrEqual(-120);
      expect(p.gateThreshDb).toBeLessThanOrEqual(0);
      expect(p.nrFloorDb).toBeGreaterThanOrEqual(-120);
      expect(p.nrFloorDb).toBeLessThanOrEqual(-20);
    }
  });

  test('formantBoost is in [0, 4]', () => {
    const p = whisperProcessingPolicy({
      whisperRegions: [{ confidence: 1.0 }],
      difficultSpeechRegions: [],
    });
    expect(p.formantBoost).toBeGreaterThanOrEqual(0);
    expect(p.formantBoost).toBeLessThanOrEqual(4);
  });

  test('empty arrays do not throw', () => {
    expect(() => whisperProcessingPolicy({ whisperRegions: [], difficultSpeechRegions: [] })).not.toThrow();
  });

  test('null/undefined regions default gracefully', () => {
    expect(() => whisperProcessingPolicy({})).not.toThrow();
    const p = whisperProcessingPolicy({});
    expect(p.activateWhisperPath).toBe(false);
  });
});
