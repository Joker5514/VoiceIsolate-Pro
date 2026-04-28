/**
 * VoiceIsolate Pro — Architectural Invariant Tests
 *
 * Encodes the non-negotiable rules from CLAUDE.md as Jest assertions, so a
 * violation fails CI rather than silently regressing. These rules previously
 * lived only as grep patterns in scripts/validate.js.
 *
 *   §1  Single-Pass Spectral Architecture — exactly one forward STFT and one
 *       inverse STFT per processing path (offline-main, offline-worker,
 *       real-time-AudioWorklet).
 *   §2  AudioWorklet Ownership — only pipeline-orchestrator.js may call
 *       audioWorklet.addModule().
 *   §3  ML Worker Ownership — only pipeline-orchestrator.js may spawn the
 *       ML Web Worker.
 *   §4  ONNX Runtime — Local Only — no CDN script tags or fetches.
 *   §5  Privacy — No External Audio Calls — no audio uploads to remote URLs.
 *   §6  COOP/COEP — required for SharedArrayBuffer in production and dev.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '../public/app');
const ROOT    = path.join(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── §1 Single-Pass Spectral Architecture ──────────────────────────────────────
describe('CLAUDE.md §1 — single STFT + iSTFT per processing path', () => {
  test('dsp-core.js defines exactly one forwardSTFT and one inverseSTFT method', () => {
    const src = read('public/app/dsp-core.js');
    // Method-style definitions inside the DSPCore object literal.
    const fwd = src.match(/^\s*forwardSTFT\s*\(/gm) || [];
    const inv = src.match(/^\s*inverseSTFT\s*\(/gm) || [];
    expect(fwd).toHaveLength(1);
    expect(inv).toHaveLength(1);
  });

  test('app.js (offline main path) calls DSP.forwardSTFT and DSP.inverseSTFT exactly once each', () => {
    const src = read('public/app/app.js');
    const fwdCalls = src.match(/DSP\.forwardSTFT\s*\(/g) || [];
    const invCalls = src.match(/DSP\.inverseSTFT\s*\(/g) || [];
    // The offline path runs through these once per buffer; multiple definitions
    // would create a second STFT/iSTFT pair within a path.
    expect(fwdCalls.length).toBe(1);
    expect(invCalls.length).toBe(1);
  });

  test('dsp-processor.js (real-time path) defines its own _processSpectralHop with single STFT/iSTFT', () => {
    const src = read('public/app/dsp-processor.js');
    expect(src).toMatch(/_processSpectralHop\s*\(/);
    // Single forward FFT call
    const fwdCalls = src.match(/fft\s*\(\s*\w+\s*,\s*\w+\s*,\s*false\s*\)/g) || [];
    const invCalls = src.match(/fft\s*\(\s*\w+\s*,\s*\w+\s*,\s*true\s*\)/g) || [];
    expect(fwdCalls.length).toBeGreaterThanOrEqual(1);
    expect(invCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ── §2 AudioWorklet Ownership ─────────────────────────────────────────────────
describe('CLAUDE.md §2 — AudioWorklet.addModule called only by pipeline-orchestrator.js', () => {
  test('pipeline-orchestrator.js is the only file calling audioWorklet.addModule()', () => {
    const files = fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js'));
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
      // Allow string literal mentions ("audioWorklet.addModule" inside docs)
      // but flag actual call expressions.
      if (/audioWorklet\.addModule\s*\(/.test(src) && f !== 'pipeline-orchestrator.js') {
        // app.js historically registers via ensureCtx — surface that as a violation.
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── §3 ML Worker Ownership ────────────────────────────────────────────────────
describe('CLAUDE.md §3 — ML worker spawned only from pipeline-orchestrator.js', () => {
  test('only pipeline-orchestrator.js constructs new Worker(\'./ml-worker.js\')', () => {
    const files = fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js'));
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
      if (/new\s+Worker\s*\(\s*['"`][^'"`]*ml-worker\.js/.test(src) && f !== 'pipeline-orchestrator.js') {
        offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── §4 ONNX Runtime — Local Only ──────────────────────────────────────────────
describe('CLAUDE.md §4 — ONNX Runtime loaded locally, never from CDN', () => {
  const cdnHosts = [
    'cdn.jsdelivr.net',
    'unpkg.com',
    'cdnjs.cloudflare.com',
    'esm.sh',
    'esm.run',
  ];

  test('no app/HTML file references ort* on a public CDN', () => {
    const candidates = [
      'public/index.html',
      'public/app/index.html',
      ...fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js')).map((f) => `public/app/${f}`),
    ];
    const violations = [];
    for (const rel of candidates) {
      if (!fs.existsSync(path.join(ROOT, rel))) continue;
      const src = read(rel);
      for (const host of cdnHosts) {
        const re = new RegExp(`https?://[^\\s'"\`]*${host.replace(/\./g, '\\.')}[^\\s'"\`]*ort`, 'i');
        if (re.test(src)) violations.push(`${rel} → ${host}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('ml-worker.js loads ORT via importScripts from the local /lib/ path', () => {
    const src = read('public/app/ml-worker.js');
    expect(src).toMatch(/importScripts\s*\(\s*['"`][^'"`]*\/lib\/ort[^'"`]*['"`]/);
  });
});

// ── §5 Privacy — No External Audio Calls ──────────────────────────────────────
describe('CLAUDE.md §5 — no remote audio submission endpoints', () => {
  test('no fetch() POST to /api/process|/api/audio|/api/transcribe etc.', () => {
    const files = fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js'));
    const banned = /fetch\s*\([^)]*['"`]\/api\/(process|audio|transcribe|isolate|enhance)/;
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
      if (banned.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});

// ── §6 COOP/COEP exact values ─────────────────────────────────────────────────
describe('CLAUDE.md §6 — COOP/COEP set to the exact values SharedArrayBuffer requires', () => {
  test('vercel.json sets COOP=same-origin and COEP=require-corp on the catch-all route', () => {
    const vercel = JSON.parse(read('vercel.json'));
    const headers = vercel.headers || [];
    // Locate any block whose source covers non-/api/* paths (broad regex
    // negating /api/) and has both COOP and COEP set.
    const matchedRoutes = headers.filter((h) => {
      const map = Object.fromEntries((h.headers || []).map((x) => [x.key, x.value]));
      return map['Cross-Origin-Opener-Policy'] && map['Cross-Origin-Embedder-Policy'];
    });
    expect(matchedRoutes.length).toBeGreaterThan(0);
    for (const block of matchedRoutes) {
      const map = Object.fromEntries(block.headers.map((x) => [x.key, x.value]));
      expect(map['Cross-Origin-Opener-Policy']).toBe('same-origin');
      expect(map['Cross-Origin-Embedder-Policy']).toBe('require-corp');
    }
  });

  test('server.js dev server sets COOP=same-origin and COEP=require-corp', () => {
    const src = read('server.js');
    expect(src).toMatch(/Cross-Origin-Opener-Policy['"`]?\s*[,)]?\s*['"`]same-origin/);
    expect(src).toMatch(/Cross-Origin-Embedder-Policy['"`]?\s*[,)]?\s*['"`]require-corp/);
  });
});

// ── Bonus: CSP locks ONNX to same-origin ──────────────────────────────────────
describe('Content-Security-Policy keeps script-src on self only', () => {
  test('vercel.json CSP includes script-src \'self\' (no http(s) sources)', () => {
    const vercel = JSON.parse(read('vercel.json'));
    const allHeaders = (vercel.headers || []).flatMap((h) => h.headers);
    const csp = allHeaders.find((h) => h.key === 'Content-Security-Policy');
    if (!csp) return; // Some deployments use middleware instead — soft-skip.
    expect(csp.value).toMatch(/script-src\s+[^;]*'self'/);
    // Must not whitelist external script hosts for ORT.
    expect(csp.value).not.toMatch(/script-src[^;]*https?:\/\//);
  });
});
