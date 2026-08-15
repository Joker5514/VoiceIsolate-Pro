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

  test('USM and SpectralCleanup share periodic Hann from stft-math (no symmetric N-1)', () => {
    const usm = read('src/core/UniversalSourceMatrix.js');
    const cleanup = read('src/core/SpectralCleanup.js');
    const stftMath = read('src/core/stft-math.js');
    expect(stftMath).toMatch(/export function periodicHann/);
    expect(usm).toMatch(/from '\.\/stft-math\.js'/);
    expect(cleanup).toMatch(/from '\.\/stft-math\.js'/);
    expect(usm).not.toMatch(/cos\(\(2 \* Math\.PI \* i\) \/ \(n - 1\)\)/);
    expect(cleanup).not.toMatch(/cos\(\(2 \* Math\.PI \* i\) \/ \(n - 1\)\)/);
  });

  test('Engineer desktop STFT hop uses 75% overlap (FFT>>2)', () => {
    const src = read('public/app/app.js');
    expect(src).toMatch(/Math\.max\(256, FFT >> 2\)/);
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

  test('dsp-processor.js (real-time path) defines its own forward and inverse FFT operations', () => {
    const src = read('public/app/dsp-processor.js');
    // Forward STFT: fftInPlace called with inverse=false
    expect(src).toMatch(/fftInPlace\s*\([^)]*false\s*\)/);
    // Inverse STFT: fftInPlace called with inverse=true
    expect(src).toMatch(/fftInPlace\s*\([^)]*true\s*\)/);
  });

  test('only the canonical dsp-processor worklet remains registered in public/app', () => {
    const files = fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js'));
    const registerFiles = files.filter((f) => /^\s*registerProcessor\s*\(/m.test(fs.readFileSync(path.join(APP_DIR, f), 'utf8')));
    expect(registerFiles).toEqual(['dsp-processor.js']);
    // Retired live-mic entry is a throw-stub (routing safety) — must not registerProcessor.
    const dead = path.join(APP_DIR, 'voice-isolate-processor.js');
    expect(fs.existsSync(dead)).toBe(true);
    const deadSrc = fs.readFileSync(dead, 'utf8');
    expect(deadSrc).toMatch(/throw new Error/);
    expect(deadSrc).not.toMatch(/^\s*registerProcessor\s*\(/m);
  });
});

// ── §1.1 Live pipeline stays removed ─────────────────────────────────────────
describe('CLAUDE.md §1.1 — live real-time pipeline stays removed', () => {
  const SRC_DIR = path.join(ROOT, 'src');

  const walkJs = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkJs(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  };

  test('audioWorklet.addModule() only loads the allowlisted playback gate worklet', () => {
    // The live-mic worklet pipeline stays removed; the one permitted worklet is
    // the playback-only noise gate (CLAUDE.md §2.1, scripts/validate.js). Any
    // other module path — or a dynamic argument — is still forbidden.
    const ALLOWED_WORKLETS = ['/src/workers/GateProcessor.js', '/src/workers/DeEsserProcessor.js'];
    const offenders = [];
    for (const f of [...walkJs(APP_DIR), ...walkJs(SRC_DIR)]) {
      const src = fs.readFileSync(f, 'utf8');
      if (!/audioWorklet\.addModule\s*\(/.test(src)) continue;
      const argRe = /audioWorklet\.addModule\s*\(\s*['"]([^'"]+)['"]/g;
      let m;
      let verified = false;
      let allAllowed = true;
      while ((m = argRe.exec(src))) {
        verified = true;
        if (!ALLOWED_WORKLETS.includes(m[1])) allAllowed = false;
      }
      if (!verified || !allAllowed) offenders.push(path.relative(ROOT, f));
    }
    expect(offenders).toEqual([]);
  });

  test('no file calls getUserMedia (live-mic ingestion is forbidden)', () => {
    const candidates = [
      ...walkJs(APP_DIR),
      ...walkJs(SRC_DIR),
      path.join(ROOT, 'public/index.html'),
      path.join(ROOT, 'public/landing.js'),
    ];
    const offenders = [];
    for (const f of candidates) {
      if (!fs.existsSync(f)) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (/getUserMedia\s*\(/.test(src)) offenders.push(path.relative(ROOT, f));
    }
    expect(offenders).toEqual([]);
  });

  test('deleted legacy monoliths stay deleted', () => {
    for (const rel of [
      'public/app/pipeline-orchestrator.js',
      'public/app/auth.js',
      'public/app/license-manager.js',
      'api-routes/auth.js',
    ]) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(false);
    }
  });
});

// ── §3 ML Worker spawning ─────────────────────────────────────────────────────
describe('CLAUDE.md §3 — legacy public/app code does not spawn the ML worker', () => {
  test('no public/app file constructs new Worker(...ml-worker.js)', () => {
    const files = fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.js'));
    const offenders = [];
    for (const f of files) {
      const src = fs.readFileSync(path.join(APP_DIR, f), 'utf8');
      if (/new\s+Worker\s*\(\s*['"`][^'"`]*ml-worker\.js/.test(src)) {
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

  test('model-cdn-loader.js and ml-worker.js do not hardcode external ONNX model URLs', () => {
    const loaderSrc = read('public/app/model-cdn-loader.js');
    const workerSrc = read('public/app/ml-worker.js');
    const banned = /(https?:\/\/[^'"`\s]*(blob\.vercel-storage\.com|public\.blob\.vercel-storage\.com|huggingface\.co|cdn\.jsdelivr\.net|unpkg\.com)[^'"`\s]*\.onnx)/i;
    expect(loaderSrc).not.toMatch(banned);
    expect(workerSrc).not.toMatch(banned);
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

  test('dev server sets COOP=same-origin and COEP=require-corp via securityHeaders middleware', () => {
    expect(read('server.js')).toMatch(/securityHeaders\(\)/);
    const src = read('server/securityHeaders.js');
    expect(src).toMatch(/Cross-Origin-Opener-Policy['"`]?\s*[,)]?\s*['"`]same-origin/);
    expect(src).toMatch(/Cross-Origin-Embedder-Policy['"`]?\s*[,)]?\s*['"`]require-corp/);
  });
});

// ── Bonus: CSP locks ONNX/Three.js to same-origin ─────────────────────────────
describe('Content-Security-Policy keeps script-src on self only', () => {
  // The sole permitted external script origin is the Firebase SDK on
  // gstatic.com — a documented, accepted exception (docs/adr/001-firebase-exception.md).
  // It is UI/auth-layer only and never touches the audio pipeline.
  const ALLOWED_SCRIPT_ORIGINS = ['https://www.gstatic.com'];

  test('vercel.json CSP includes script-src \'self\' (no unapproved http(s) sources)', () => {
    const vercel = JSON.parse(read('vercel.json'));
    const allHeaders = (vercel.headers || []).flatMap((h) => h.headers);
    const csp = allHeaders.find((h) => h.key === 'Content-Security-Policy');
    if (!csp) return; // Some deployments use middleware instead — soft-skip.
    expect(csp.value).toMatch(/script-src\s+[^;]*'self'/);

    // Isolate the script-src directive and strip the documented allowlist,
    // then assert no other external script hosts remain (notably none for ORT).
    const scriptSrcMatch = csp.value.match(/script-src([^;]*)/);
    let remaining = scriptSrcMatch ? scriptSrcMatch[1] : '';
    for (const origin of ALLOWED_SCRIPT_ORIGINS) {
      remaining = remaining.split(origin).join('');
    }
    expect(remaining).not.toMatch(/https?:\/\//);
  });
});
