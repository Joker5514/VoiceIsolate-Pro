/**
 * Desktop / Electron post-ML finalization — unstick progress after ~88%.
 * Structural + unit coverage for cooperative loops and progress bands.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const stemJs = fs.readFileSync(path.join(ROOT, 'src/pipeline/StemSeparation.js'), 'utf8');
const yieldJs = fs.readFileSync(path.join(ROOT, 'src/pipeline/ui-yield.js'), 'utf8');

describe('desktop 88% progress semantics', () => {
  test('ML progress maps into 8–82 band (leaves room for reconstruct)', () => {
    expect(appJs).toMatch(/8 \+ Math\.round\(w \* 0\.74\)/);
  });

  test('post-ML stages report incremental progress 82→100', () => {
    expect(appJs).toMatch(/Reconstructing stems…',\s*82/);
    expect(appJs).toMatch(/Expanding stereo/);
    expect(appJs).toMatch(/Smoothing residual/);
    expect(appJs).toMatch(/Building output…',\s*96/);
    expect(appJs).toMatch(/Loading Live-Mix…',\s*97/);
    expect(appJs).toMatch(/Output safety…',\s*98/);
    expect(appJs).toMatch(/Complete',\s*100/);
  });

  test('Complete is marked before deferred auto-analysis is scheduled', () => {
    const complete = appJs.indexOf("updatePipelineProgress(32, 'Complete', 100");
    const deferred = appJs.indexOf('_deferredAnalysisFileSeq');
    expect(complete).toBeGreaterThan(0);
    expect(deferred).toBeGreaterThan(complete);
  });

  test('desktop Electron uses 1s post-ML chunks (not 4s)', () => {
    expect(appJs).toMatch(/_postMlChunkSamples/);
    expect(appJs).toMatch(/isDesktopShell\(\)\) return 48000/);
  });
});

describe('cooperative post-ML utilities', () => {
  let uiYield;

  beforeAll(async () => {
    uiYield = await import(pathToFileURL(path.join(ROOT, 'src/pipeline/ui-yield.js')).href);
  });

  test('throwIfAborted raises AbortError', () => {
    expect(() => uiYield.throwIfAborted({ aborted: true })).toThrow();
    try {
      uiYield.throwIfAborted({ aborted: true });
    } catch (err) {
      expect(err.name).toBe('AbortError');
    }
  });

  test('processInChunks yields at least once for large totals', async () => {
    let yields = 0;
    const orig = uiYield.yieldToBrowser;
    // Spy via wrapping processInChunks' dependency — call processInChunks with tiny chunks
    let chunks = 0;
    await uiYield.processInChunks({
      total: 100,
      chunkSize: 40,
      runChunk: () => { chunks += 1; },
      onProgress: () => { yields += 1; },
    });
    expect(chunks).toBeGreaterThanOrEqual(3);
    expect(yields).toBeGreaterThanOrEqual(3);
    void orig;
  });

  test('processInChunks respects AbortSignal mid-loop', async () => {
    const signal = { aborted: false };
    let saw = 0;
    await expect(uiYield.processInChunks({
      total: 1000,
      chunkSize: 100,
      signal,
      runChunk: () => {
        saw += 1;
        if (saw >= 2) signal.aborted = true;
      },
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(saw).toBeGreaterThanOrEqual(2);
  });

  test('exports desktop yield budget constant', () => {
    expect(yieldJs).toContain('YIELD_BUDGET_DESKTOP_MS');
    expect(uiYield.YIELD_BUDGET_DESKTOP_MS).toBe(10);
  });
});

describe('StemSeparation worker terminal contract', () => {
  test('handles cancelled + messageerror and cleans timers', () => {
    expect(stemJs).toMatch(/type === 'cancelled'/);
    expect(stemJs).toMatch(/messageerror/);
    expect(stemJs).toMatch(/clearInterval\(stallWatch\)/);
    expect(stemJs).toMatch(/clearTimeout\(timer\)/);
    expect(stemJs).toMatch(/settled/);
  });

  test('ignores stale requestId on stems/error', () => {
    expect(stemJs).toMatch(/m\.requestId !== requestId/);
  });

  test('forwards AbortSignal as worker cancel and rejects late stems', () => {
    expect(stemJs).toMatch(/options\.signal/);
    expect(stemJs).toMatch(/type: 'cancel'/);
    expect(stemJs).toMatch(/cancelPosted/);
    expect(stemJs).toMatch(/cancelStemSeparation/);
  });

  test('cancelActiveJobs posts cancel before recycle', () => {
    expect(appJs).toMatch(/cancelStemSeparation/);
    expect(appJs).toMatch(/signal:\s*this\._processAbortSignal\(\)/);
  });
});

describe('DSP fallback must not pin at 88%', () => {
  test('fallback render uses cooperative chunks past 88', () => {
    expect(appJs).toMatch(/Rendering output…',\s*90/);
    expect(appJs).toMatch(/fallback-render-start/);
    const fbStart = appJs.indexOf('async _runFallbackPipeline');
    const fbBody = appJs.slice(fbStart, fbStart + 12000);
    expect(fbBody).toMatch(/processInChunks/);
    expect(fbBody).not.toMatch(/Rendering output…',\s*88/);
  });
});

describe('local-only / architecture guards still present', () => {
  test('no new STFT in postIsolationDeWhistle', () => {
    const start = appJs.indexOf('async _postIsolationDeWhistle');
    const end = appJs.indexOf('async _applyOutputSafetyLimitAsync') > start
      ? appJs.indexOf('async _applyOutputSafetyLimitAsync')
      : appJs.indexOf('applyDither(buf');
    const body = appJs.slice(start, end);
    expect(body).not.toMatch(/\._fft\(|forwardStft|inverseStft/i);
  });

  test('progress diagnostics are local-only gated', () => {
    expect(appJs).toMatch(/vip-debug-progress/);
    expect(appJs).toMatch(/VIP_DEBUG_PROGRESS/);
    expect(appJs).toMatch(/elapsedMs/);
    expect(appJs).toMatch(/abortReason/);
    expect(appJs).not.toMatch(/fetch\(.*progress/i);
  });

  test('production Process does not import dsp-stages.js', () => {
    expect(appJs).not.toMatch(/dsp-stages/);
    expect(appJs).not.toMatch(/offline-processor/);
  });
});

describe('USM / ORT hardening markers', () => {
  const usmWorker = fs.readFileSync(path.join(ROOT, 'src/workers/USMWorker.js'), 'utf8');
  const mlWorker = fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8');
  const usmNode = fs.readFileSync(path.join(ROOT, 'src/pipeline/USMNode.js'), 'utf8');

  test('USMWorker clears heartbeat in finally', () => {
    expect(usmWorker).toMatch(/finally\s*\{/);
    expect(usmWorker).toMatch(/clearHeartbeat/);
  });

  test('USMNode handles messageerror', () => {
    expect(usmNode).toMatch(/messageerror/);
  });

  test('MLWorker allows one local WASM retry after WebGPU session failure', () => {
    expect(mlWorker).toMatch(/_webgpuWasmFallbackUsed/);
    expect(mlWorker).toMatch(/one local WASM retry/);
    expect(mlWorker).toMatch(/ort-fallback/);
  });
});
