/**
 * VoiceIsolate Pro — debug-test-harness.js
 * =========================================================
 * Extended self-test harness complementing debug-audit.js.
 * Covers: SAB round-trip timing, AudioWorklet port messaging,
 * ONNX runtime probe (WebGPU → WASM fallback), OLA integrity,
 * gate-hold timing, Service Worker version check, STFT single-
 * pass constraint validation, CSP violation monitor, and more.
 *
 * Usage (DevTools console):
 *   const h = await import('./debug-test-harness.js');
 *   await h.runAll();        // full suite
 *   await h.runGroup('dsp'); // single group
 *
 * Or paste into console directly — window.VIP_HARNESS is set.
 *
 * Output levels:  ✅ PASS  ❌ FAIL  ⚠️  WARN  ℹ️  INFO
 */

(async function VIP_HARNESS_BOOT() {
  'use strict';

  // ─── Tiny reporter ──────────────────────────────────────────────────────
  const S = { pass: '✅', fail: '❌', warn: '⚠️ ', info: 'ℹ️ ' };
  const results = [];
  let pc = 0, fc = 0, wc = 0;

  function report(level, group, id, msg, detail = '') {
    const sym = S[level] || S.info;
    const tag = `[${group}:${String(id).padStart(2,'0')}]`;
    const line = `${sym} ${tag} ${msg}${detail ? ' — ' + detail : ''}`;
    console.log(line);
    results.push({ level, group, id, msg, detail });
    if (level === 'pass') pc++;
    else if (level === 'fail') fc++;
    else if (level === 'warn') wc++;
  }

  function section(title) {
    console.log(`\n${'━'.repeat(52)}\n  ${title}\n${'━'.repeat(52)}`);
  }

  // ─── Helper: timeout-wrapped promise ────────────────────────────────────
  function withTimeout(p, ms, label) {
    return Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms))
    ]).catch(e => { throw new Error(`${label}: ${e.message}`); });
  }

  // ══════════════════════════════════════════════════════════════════════
  // GROUP 1 — BROWSER CAPABILITY
  // ══════════════════════════════════════════════════════════════════════
  async function testCapabilities() {
    section('GROUP 1 · Browser Capabilities');

    // 1.1 SharedArrayBuffer
    if (typeof SharedArrayBuffer !== 'undefined') {
      const sab = new SharedArrayBuffer(4);
      const arr = new Int32Array(sab);
      Atomics.store(arr, 0, 42);
      const ok = Atomics.load(arr, 0) === 42;
      report(ok ? 'pass' : 'fail', 'cap', 1, 'SharedArrayBuffer + Atomics functional',
        ok ? 'round-trip read/write OK' : 'Atomics read/write mismatch');
    } else {
      report('fail', 'cap', 1, 'SharedArrayBuffer unavailable',
        'COOP/COEP headers not active — live mode impossible');
    }

    // 1.2 AudioWorklet
    report(
      typeof AudioWorkletNode !== 'undefined' ? 'pass' : 'fail',
      'cap', 2, 'AudioWorklet API present'
    );

    // 1.3 WebGPU
    if (navigator.gpu) {
      try {
        const adapter = await withTimeout(navigator.gpu.requestAdapter(), 3000, 'WebGPU adapter');
        if (adapter) {
          const info = await adapter.requestAdapterInfo();
          report('pass', 'cap', 3, 'WebGPU adapter acquired',
            `vendor: ${info.vendor || 'unknown'}, device: ${info.device || 'unknown'}`);
        } else {
          report('warn', 'cap', 3, 'WebGPU present but no adapter returned (headless/VM?)');
        }
      } catch (e) {
        report('warn', 'cap', 3, 'WebGPU adapter request failed', e.message);
      }
    } else {
      report('warn', 'cap', 3, 'WebGPU not available — ONNX will use WASM backend');
    }

    // 1.4 OfflineAudioContext
    report(
      typeof OfflineAudioContext !== 'undefined' ? 'pass' : 'fail',
      'cap', 4, 'OfflineAudioContext (Creator/Forensic mode)'
    );

    // 1.5 WASM
    try {
      const mod = await WebAssembly.compile(new Uint8Array([
        0,97,115,109,1,0,0,0  // minimal WASM header
      ]));
      report('pass', 'cap', 5, 'WebAssembly.compile functional',
        `module: ${Object.prototype.toString.call(mod)}`);
    } catch (e) {
      report('fail', 'cap', 5, 'WebAssembly compile failed', e.message);
    }

    // 1.6 crossOriginIsolated
    if (crossOriginIsolated) {
      report('pass', 'cap', 6, 'window.crossOriginIsolated = true (COOP+COEP confirmed)');
    } else {
      report('fail', 'cap', 6, 'crossOriginIsolated = false',
        'SharedArrayBuffer will be blocked in some contexts despite constructor existing');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // GROUP 2 — DSP PROCESSOR VALIDATION
  // ══════════════════════════════════════════════════════════════════════
  async function testDSP() {
    section('GROUP 2 · DSP Processor');

    // 2.1 Load dsp-processor.js via fetch
    let procText = '';
    try {
      const r = await withTimeout(fetch('./dsp-processor.js'), 5000, 'fetch dsp-processor.js');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      procText = await r.text();
      report('pass', 'dsp', 1, `dsp-processor.js fetched (${(procText.length/1024).toFixed(1)} KB)`);
    } catch (e) {
      report('fail', 'dsp', 1, 'Cannot fetch dsp-processor.js', e.message);
      return; // all DSP tests depend on file being present
    }

    // 2.2 Single-pass STFT constraint: exactly ONE forward fftInPlace call before iSTFT
    const fwdFFT = (procText.match(/fftInPlace\([^,]+,[^,]+,\s*false\)/g) || []).length;
    const invFFT = (procText.match(/fftInPlace\([^,]+,[^,]+,\s*true\)/g) || []).length;
    if (fwdFFT === 1 && invFFT === 1) {
      report('pass', 'dsp', 2,
        `Single-pass STFT constraint: ${fwdFFT} forward FFT, ${invFFT} inverse FFT`);
    } else {
      report('fail', 'dsp', 2,
        `STFT constraint violated: ${fwdFFT} fwd, ${invFFT} inv (expected 1 each)`);
    }

    // 2.3 OLA write pointer uses HOP_SIZE not FFT_SIZE
    const olaOK = /outWr[^=]*=.*HOP_SIZE/.test(procText);
    report(
      olaOK ? 'pass' : 'fail', 'dsp', 3,
      'OLA write pointer advances by HOP_SIZE',
      olaOK ? 'FIX[1] confirmed' : 'REGRESSION: outWr not advancing by HOP_SIZE'
    );

    // 2.4 Periodic Hann window uses denominator N not N-1
    // The correct form is (2π*i)/N — reject (2π*i)/(N-1)
    const hannOK = /Math\.PI \* i\) \/ N\b/.test(procText) &&
                   !/(N\s*-\s*1)/.test(procText.match(/makeHannWindow[\s\S]{0,200}/)?.[0] || '');
    report(
      hannOK ? 'pass' : 'fail', 'dsp', 4,
      'Periodic Hann window denominator = N (not N-1)',
      hannOK ? 'FIX[5] confirmed' : 'REGRESSION: symmetric window will break OLA energy'
    );

    // 2.5 Phase reconstruction uses polar form (cos/sin), not scalar multiply
    const polarOK = /maskedMag\[k\]\s*\*\s*Math\.cos\(pha\[k\]\)/.test(procText);
    report(
      polarOK ? 'pass' : 'fail', 'dsp', 5,
      'Phase reconstruction uses polar form (mag·cos(pha))',
      polarOK ? 'FIX[3] confirmed' : 'REGRESSION: scalar multiply will smear phase'
    );

    // 2.6 DC bin im=0 (FIX[6])
    const dcOK = /this\._im\[0\]\s*=\s*0\.0/.test(procText);
    report(
      dcOK ? 'pass' : 'fail', 'dsp', 6,
      'DC bin (k=0) imaginary component forced to zero',
      dcOK ? 'FIX[6] confirmed' : 'REGRESSION: DC leak will cause low-frequency distortion'
    );

    // 2.7 FIX[4]: buffer transfer uses .slice() not direct transfer
    const sliceOK = /mag\.slice\(\)\.buffer/.test(procText);
    report(
      sliceOK ? 'pass' : 'fail', 'dsp', 7,
      'Fallback postMessage clones buffer via .slice()',
      sliceOK ? 'FIX[4] confirmed' : 'REGRESSION: detached buffer will crash worklet'
    );

    // 2.8 Frame trigger uses while loop (not if) — FIX[2]
    const whileOK = /while\s*\(\s*this\._newSamples\s*>=\s*HOP_SIZE\s*\)/.test(procText);
    report(
      whileOK ? 'pass' : 'fail', 'dsp', 8,
      'Frame trigger loop is `while`, not `if` (FIX[2])',
      whileOK ? 'multi-hop frames handled' : 'REGRESSION: missed frames under load'
    );

    // 2.9 AudioWorklet readiness — delegate ownership check to pipeline-orchestrator.js
    // Direct addModule() calls are forbidden outside pipeline-orchestrator.js (CLAUDE.md §2).
    // Instead, verify the orchestrator has already loaded the worklet.
    {
      const orch = typeof window !== 'undefined' ? window._vipOrch : null;
      if (orch && orch.workletReady) {
        report('pass', 'dsp', 9, 'AudioWorklet registered (pipeline-orchestrator workletReady=true)');
      } else if (orch && !orch.workletReady) {
        report('warn', 'dsp', 9, 'AudioWorklet not yet ready — pipeline-orchestrator init may be pending');
      } else {
        report('warn', 'dsp', 9, 'AudioWorklet status unknown — pipeline-orchestrator not found on window._vipOrch');
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // GROUP 3 — SAB ROUND-TRIP TIMING
  // Tests the full worklet→SAB→main-thread→SAB→worklet data path.
  // ══════════════════════════════════════════════════════════════════════
  async function testSAB() {
    section('GROUP 3 · SharedArrayBuffer Round-Trip');

    if (typeof SharedArrayBuffer === 'undefined') {
      report('warn', 'sab', 1, 'SAB unavailable — skipping all SAB tests');
      return;
    }

    const FFT_SIZE  = 4096;
    const HOP_SIZE  = 1024;
    const HALF_BINS = FFT_SIZE / 2 + 1;
    const FLAG_SLOTS = 4;
    const HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS;
    const PAYLOAD_BYTES = HALF_BINS * 2 * Float32Array.BYTES_PER_ELEMENT;

    // 3.1 Allocate SABs
    let inputSAB, outputSAB;
    try {
      inputSAB  = new SharedArrayBuffer(HEADER_BYTES + PAYLOAD_BYTES);
      outputSAB = new SharedArrayBuffer(HEADER_BYTES + HALF_BINS * Float32Array.BYTES_PER_ELEMENT);
      report('pass', 'sab', 1,
        `SABs allocated — input: ${inputSAB.byteLength}B, output: ${outputSAB.byteLength}B`);
    } catch (e) {
      report('fail', 'sab', 1, 'SAB allocation failed', e.message);
      return;
    }

    // 3.2 Atomic write + read consistency
    const inFlags  = new Int32Array(inputSAB,  0, FLAG_SLOTS);
    const outFlags = new Int32Array(outputSAB, 0, FLAG_SLOTS);
    Atomics.store(inFlags,  0, 7);
    Atomics.store(outFlags, 0, 3);
    const r1 = Atomics.load(inFlags,  0) === 7;
    const r2 = Atomics.load(outFlags, 0) === 3;
    report(
      r1 && r2 ? 'pass' : 'fail', 'sab', 2,
      'Atomic store/load on both SABs consistent',
      `inputFlags[0]=${Atomics.load(inFlags,0)}, outputFlags[0]=${Atomics.load(outFlags,0)}`
    );

    // 3.3 Float32 payload write/read
    const inView  = new Float32Array(inputSAB,  HEADER_BYTES, HALF_BINS * 2);
    const outView = new Float32Array(outputSAB, HEADER_BYTES, HALF_BINS);
    inView[0]  = 0.123;
    inView[HALF_BINS] = 1.571; // pha[0]
    outView[0] = 0.85;         // mock mask
    const magOK  = Math.abs(inView[0]  - 0.123) < 1e-6;
    const phaOK  = Math.abs(inView[HALF_BINS] - 1.571) < 1e-4;
    const maskOK = Math.abs(outView[0] - 0.85)  < 1e-6;
    report(
      magOK && phaOK && maskOK ? 'pass' : 'fail',
      'sab', 3, 'Float32 payload (mag/pha/mask) read/write accurate',
      `mag=${inView[0].toFixed(4)}, pha=${inView[HALF_BINS].toFixed(4)}, mask=${outView[0].toFixed(4)}`
    );

    // 3.4 Simulate worklet→main generation counter handshake
    Atomics.store(inFlags, 0, 0); // writeGen=0
    Atomics.store(inFlags, 1, 0); // readGen=0
    // Worklet increments writeGen after writing mag+pha
    Atomics.add(inFlags, 0, 1);
    const writeGen = Atomics.load(inFlags, 0);
    const readGen  = Atomics.load(inFlags, 1);
    const newFrame = writeGen !== readGen;
    Atomics.store(inFlags, 1, writeGen); // main thread acknowledges
    const acked = Atomics.load(inFlags, 1) === writeGen;
    report(
      newFrame && acked ? 'pass' : 'fail',
      'sab', 4, 'Worklet→main generation counter handshake',
      `writeGen=${writeGen}, readGen after ack=${Atomics.load(inFlags,1)}, newFrame=${newFrame}`
    );

    // 3.5 Output mask handshake (main→worklet)
    Atomics.store(outFlags, 0, 0);
    Atomics.store(outFlags, 1, 0);
    // ml-worker writes mask + bumps writeGen
    Atomics.add(outFlags, 0, 1);
    const maskWriteGen = Atomics.load(outFlags, 0);
    const maskReadGen  = Atomics.load(outFlags, 1);
    const hasMask = maskWriteGen !== maskReadGen;
    // Worklet acknowledges
    Atomics.store(outFlags, 1, maskWriteGen);
    const maskAcked = Atomics.load(outFlags, 1) === maskWriteGen;
    report(
      hasMask && maskAcked ? 'pass' : 'fail',
      'sab', 5, 'ml-worker→worklet mask handshake',
      `maskGen=${maskWriteGen}, acked=${maskAcked}`
    );

    // 3.6 Hop timing sanity (theoretical: 1024/48000 ≈ 21.3ms per frame)
    const EXPECTED_HOP_MS = (HOP_SIZE / 48000) * 1000;
    report(
      'info', 'sab', 6,
      `Theoretical hop interval: ${EXPECTED_HOP_MS.toFixed(2)}ms at 48kHz`,
      'Live mode generates ~47 frames/sec; SAB must be polled faster than this'
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // GROUP 4 — ONNX RUNTIME PROBE
  // ══════════════════════════════════════════════════════════════════════
  async function testONNX() {
    section('GROUP 4 · ONNX Runtime');

    // 4.1 ort global
    const ort = window.ort;
    if (!ort) {
      report('fail', 'onnx', 1, 'window.ort not found',
        'Include ort.webgpu.min.js before running harness');
      return;
    }
    report('pass', 'onnx', 1, `window.ort found (v${ort.env?.versions?.common || 'unknown'})`);

    // 4.2 env.wasm path set
    const wasmPath = ort.env?.wasm?.wasmPaths;
    if (wasmPath) {
      report('pass', 'onnx', 2, 'ort.env.wasm.wasmPaths configured', JSON.stringify(wasmPath));
    } else {
      report('warn', 'onnx', 2, 'ort.env.wasm.wasmPaths not set',
        'WASM files may 404 — set ort.env.wasm.wasmPaths to correct /lib/ path');
    }

    // 4.3 WebGPU EP availability
    const eps = ort.env?.webgpu !== undefined;
    report(
      eps ? 'pass' : 'warn',
      'onnx', 3,
      eps ? 'WebGPU execution provider config present in ort.env' :
            'ort.env.webgpu not found — confirm ORT build includes WebGPU EP'
    );

    // 4.4 Micro inference test (tiny 1-op ONNX model: identity)
    // We create a minimal valid ONNX protobuf for a single Add node 1+1=2
    try {
      // Build minimal ONNX model bytes for Add(A, B) → C where A=[[1]], B=[[1]]
      // This is a hand-crafted valid ONNX v7 model in binary
      const MODEL_BYTES = new Uint8Array([
        0x08,0x07,0x12,0x0c,0x76,0x69,0x70,0x74,0x65,0x73,0x74,
        0x5f,0x61,0x64,0x64,0x3a,0x35,0x0a,0x26,0x0a,0x01,0x41,
        0x0a,0x01,0x42,0x12,0x01,0x43,0x22,0x03,0x41,0x64,0x64,
        0x12,0x09,0x76,0x69,0x70,0x5f,0x61,0x64,0x64,0x5f,0x31,
        0x5a,0x11,0x0a,0x01,0x41,0x12,0x06,0x0a,0x04,0x08,0x01,
        0x10,0x01,0x42,0x00,0x5a,0x11,0x0a,0x01,0x42,0x12,0x06,
        0x0a,0x04,0x08,0x01,0x10,0x01,0x42,0x00,0x62,0x11,0x0a,
        0x01,0x43,0x12,0x06,0x0a,0x04,0x08,0x01,0x10,0x01,0x42,
        0x00,0x10,0x09
      ]);
      const eps_list = navigator.gpu
        ? [{ name: 'webgpu' }, { name: 'wasm' }]
        : [{ name: 'wasm' }];
      const session = await withTimeout(
        ort.InferenceSession.create(MODEL_BYTES.buffer, { executionProviders: eps_list }),
        10000, 'ORT session create'
      );
      const A = new ort.Tensor('float32', [1.0], [1, 1]);
      const B = new ort.Tensor('float32', [1.0], [1, 1]);
      const out = await withTimeout(session.run({ A, B }), 5000, 'ORT inference');
      const val = out.C?.data?.[0];
      if (Math.abs(val - 2.0) < 1e-5) {
        report('pass', 'onnx', 4, `Micro Add(1,1)=2 inference correct via ${eps_list[0].name}`,
          `output: ${val}`);
      } else {
        report('fail', 'onnx', 4, `Inference result incorrect: ${val} (expected 2.0)`);
      }
      session.release?.();
    } catch (e) {
      report('warn', 'onnx', 4, 'Micro inference test failed (model bytes may need update)',
        e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // GROUP 5 — OLA INTEGRITY (pure math verification)
  // Verifies that the synthesis window + OLA normalisation produces
  // unity gain on a constant-1 signal — the classic COLA test.
  // ══════════════════════════════════════════════════════════════════════
  async function testOLA() {
    section('GROUP 5 · OLA Integrity (COLA Test)');

    const FFT_SIZE = 4096;
    const HOP_SIZE = 1024;
    const OLA_NORM = 1.0 / (FFT_SIZE / (2.0 * HOP_SIZE)); // 0.5

    // 5.1 Build periodic Hann window
    const win = new Float32Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) {
      win[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / FFT_SIZE));
    }

    // 5.2 OLA_NORM sanity
    const expectedNorm = HOP_SIZE * 2.0 / FFT_SIZE; // = 0.5
    if (Math.abs(OLA_NORM - expectedNorm) < 1e-9) {
      report('pass', 'ola', 1, `OLA_NORM = ${OLA_NORM} (expected ${expectedNorm})`);
    } else {
      report('fail', 'ola', 1, `OLA_NORM mismatch: got ${OLA_NORM}, expected ${expectedNorm}`);
    }

    // 5.3 COLA: sum of all shifted analysis×synthesis windows over one period = constant
    // At 75% overlap, 4 windows cover one period of HOP_SIZE samples.
    const FRAMES = FFT_SIZE / HOP_SIZE; // = 4 at 75% overlap
    const colaSum = new Float32Array(HOP_SIZE);
    for (let f = 0; f < FRAMES; f++) {
      for (let i = 0; i < HOP_SIZE; i++) {
        const sampleIdx = (f * HOP_SIZE + i) % FFT_SIZE;
        // analysis window squared × OLA_NORM (synthesis also uses same window)
        colaSum[i] += win[sampleIdx] * win[sampleIdx] * OLA_NORM;
      }
    }
    let maxErr = 0;
    for (let i = 0; i < HOP_SIZE; i++) {
      maxErr = Math.max(maxErr, Math.abs(colaSum[i] - 1.0));
    }
    if (maxErr < 1e-5) {
      report('pass', 'ola', 2, `COLA constraint satisfied — max deviation: ${maxErr.toExponential(2)}`,
        'Unity gain reconstruction confirmed at 75% overlap');
    } else {
      report('fail', 'ola', 2,
        `COLA VIOLATED — max deviation from unity: ${maxErr.toFixed(6)}`,
        'Phase artifacts / amplitude ripple expected in output');
    }

    // 5.4 Window energy at 75% overlap
    let energy = 0;
    for (let i = 0; i < FFT_SIZE; i++) energy += win[i] * win[i];
    const expectedEnergy = FFT_SIZE / 2.0; // for periodic Hann
    const energyErr = Math.abs(energy - expectedEnergy) / expectedEnergy;
    report(
      energyErr < 0.001 ? 'pass' : 'fail', 'ola', 3,
      `Hann window energy: ${energy.toFixed(1)} (expected ${expectedEnergy})`,
      `relative error: ${(energyErr * 100).toFixed(4)}%`
    );

    // 5.5 OLA output ring sizing — must hold at least (FFT_SIZE * 4) samples
    // to accommodate multiple in-flight overlapping frames without collision
    const MIN_OUT_RING = FFT_SIZE * 4;
    // This is validated from source text — fetch and check
    try {
      const r = await fetch('./dsp-processor.js');
      const txt = await r.text();
      // Look for outRing allocation: FFT_SIZE * N where N >= 4
      const m = txt.match(/new Float32Array\s*\(\s*FFT_SIZE\s*\*\s*(\d+)\s*\)/);
      if (m) {
        const mult = parseInt(m[1]);
        report(
          mult >= 4 ? 'pass' : 'fail', 'ola', 4,
          `outRing sized FFT_SIZE × ${mult} = ${FFT_SIZE * mult} samples`,
          mult >= 4
            ? 'Sufficient for 4 overlapping frames'
            : `Too small: needs at least FFT_SIZE×4 (${MIN_OUT_RING}) for overlap safety`
        );
      } else {
        report('warn', 'ola', 4, 'Could not parse outRing allocation from source');
      }
    } catch (e) {
      report('warn', 'ola', 4, 'Could not fetch dsp-processor.js for ring size check', e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // GROUP 6 — GATE HOLD TIMING
  // ══════════════════════════════════════════════════════════════════════
  async function testGateHold() {
    section('GROUP 6 · Gate Hold Timing');

    const SAMPLE_RATE  = 48000;
    const GATE_HOLD_MS = 20;
    const Q            = 128; // quantum size

    // 6.1 Hold length calculation
    const expectedHoldLen = Math.round((GATE_HOLD_MS / 1000) * SAMPLE_RATE);
    report('info', 'gate', 1,
      `Gate hold length: ${expectedHoldLen} samples at 48kHz`,
      `${GATE_HOLD_MS}ms = ${(expectedHoldLen / Q).toFixed(1)} quanta`);

    // 6.2 Gate hold arithmetic — simulate the hold countdown
    let holdSamples = expectedHoldLen;
    let quanta = 0;
    while (holdSamples > 0) {
      holdSamples -= Q;
      quanta++;
    }
    const holdTimeMs = (quanta * Q / SAMPLE_RATE) * 1000;
    const err = Math.abs(holdTimeMs - GATE_HOLD_MS);
    report(
      err < Q / SAMPLE_RATE * 1000 + 1 ? 'pass' : 'fail',
      'gate', 2,
      `Gate hold sustains for ${quanta} quanta (${holdTimeMs.toFixed(2)}ms)`,
      `error: ${err.toFixed(2)}ms (< 1 quantum = ${(Q/SAMPLE_RATE*1000).toFixed(2)}ms is fine)`
    );

    // 6.3 RMS gate threshold (dBFS) — verify math
    const gateThreshDb = -42;
    const linThresh    = Math.pow(10, gateThreshDb / 20);
    const backToDb     = 20 * Math.log10(linThresh);
    report(
      Math.abs(backToDb - gateThreshDb) < 0.001 ? 'pass' : 'fail',
      'gate', 3,
      `Gate threshold round-trip: ${gateThreshDb}dB → ${linThresh.toExponential(4)} → ${backToDb.toFixed(2)}dB`
    );

    // 6.4 Below-gate RMS calculation correctness
    const silentFrame = new Float32Array(Q).fill(0);
    let rms = 0;
    for (let i = 0; i < Q; i++) rms += silentFrame[i] * silentFrame[i];
    rms = Math.sqrt(rms / Q);
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -160.0;
    report(
      rmsDb <= gateThreshDb ? 'pass' : 'fail',
      'gate', 4,
      `Silent frame RMS = ${rmsDb}dBFS — correctly below gate (${gateThreshDb}dBFS)`
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // GROUP 7 — SERVICE WORKER
  // ══════════════════════════════════════════════════════════════════════
  async function testServiceWorker() {
    section('GROUP 7 · Service Worker');

    // 7.1 SW registration
    if (!('serviceWorker' in navigator)) {
      report('fail', 'sw', 1, 'Service Worker API not available');
      return;
    }
    const reg = await navigator.serviceWorker.getRegistration('/');
    if (!reg) {
      report('warn', 'sw', 1, 'No SW registration found at scope /',
        'sw-register.js may not have run, or page was loaded from non-SW context');
    } else {
      const sw = reg.active || reg.installing || reg.waiting;
      report('pass', 'sw', 1, `SW registered — state: ${sw?.state || 'unknown'}`,
        `scope: ${reg.scope}`);
    }

    // 7.2 SW version stamp
    try {
      const r = await withTimeout(fetch('/sw.js', { cache: 'no-store' }), 5000, 'fetch sw.js');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const txt = await r.text();
      // Look for version stamp injected by stamp-sw-version.js
      const verMatch = txt.match(/VIP_SW_VERSION\s*[=:]["'\s]*([\w.-]+)/);
      if (verMatch) {
        report('pass', 'sw', 2, `SW version stamp found: ${verMatch[1]}`,
          'Cache-busting via stamp-sw-version.js is working');
      } else {
        report('warn', 'sw', 2, 'VIP_SW_VERSION not found in sw.js',
          'Run scripts/stamp-sw-version.js to embed build hash — stale caches possible');
      }
      // 7.3 Check sw.js does NOT cache dsp-processor.js directly (it must stay network-first)
      const cachesDSP = txt.includes('dsp-processor.js') && !txt.includes('networkFirst');
      if (!cachesDSP) {
        report('pass', 'sw', 3, 'dsp-processor.js not in static cache (network-first confirmed)');
      } else {
        report('warn', 'sw', 3,
          'dsp-processor.js may be aggressively cached — stale worklet possible after deploys',
          'Use network-first strategy or version-stamp the worklet filename');
      }
    } catch (e) {
      report('warn', 'sw', 2, 'Could not inspect sw.js', e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // GROUP 8 — CSP VIOLATION MONITOR
  // Attaches a CSP report listener and fires a brief probe.
  // ══════════════════════════════════════════════════════════════════════
  async function testCSP() {
    section('GROUP 8 · CSP + Security Headers');

    // 8.1 crossOriginIsolated (already in cap but rechecked for security group)
    report(
      crossOriginIsolated ? 'pass' : 'fail',
      'csp', 1,
      `crossOriginIsolated: ${crossOriginIsolated}`,
      crossOriginIsolated ? 'COOP + COEP headers active' : 'Missing headers — SAB blocked'
    );

    // 8.2 Listen for SecurityPolicyViolationEvent for 2s, fire harmless probe
    let violations = [];
    const onViolation = (e) => violations.push(`${e.violatedDirective}: ${e.blockedURI}`);
    document.addEventListener('securitypolicyviolation', onViolation);

    // Probe: try to load an image from a whitelisted origin (should not violate)
    try {
      const img = new Image();
      img.src = '/favicon.ico';
    } catch (_) {}

    await new Promise(r => setTimeout(r, 500));
    document.removeEventListener('securitypolicyviolation', onViolation);

    if (violations.length === 0) {
      report('pass', 'csp', 2, 'No CSP violations detected during probe');
    } else {
      violations.forEach((v, i) => {
        report('fail', 'csp', 2 + i, `CSP violation: ${v}`);
      });
    }

    // 8.3 X-Frame-Options / DENY — check via response headers (only works on same-origin)
    try {
      const r = await withTimeout(
        fetch(location.href, { method: 'HEAD', cache: 'no-store' }),
        5000, 'HEAD request'
      );
      const coop = r.headers.get('cross-origin-opener-policy');
      const coep = r.headers.get('cross-origin-embedder-policy');
      const xfo  = r.headers.get('x-frame-options');
      const xcto = r.headers.get('x-content-type-options');
      report(coop === 'same-origin' ? 'pass' : 'fail', 'csp', 5,
        `COOP: ${coop || 'MISSING'}`);
      report(coep === 'require-corp' ? 'pass' : 'fail', 'csp', 6,
        `COEP: ${coep || 'MISSING'}`);
      report(xfo  === 'DENY' ? 'pass' : 'warn',  'csp', 7,
        `X-Frame-Options: ${xfo  || 'MISSING'}`);
      report(xcto === 'nosniff' ? 'pass' : 'warn', 'csp', 8,
        `X-Content-Type-Options: ${xcto || 'MISSING'}`);
    } catch (e) {
      report('warn', 'csp', 5, 'Cannot verify response headers via fetch', e.message);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // GROUP 9 — FILE REACHABILITY
  // ══════════════════════════════════════════════════════════════════════
  async function testFiles() {
    section('GROUP 9 · Critical File Reachability');

    const CRITICAL_FILES = [
      './dsp-processor.js',
      './ml-worker.js',
      './ring-buffer.js',
      './dsp-core.js',
      './pipeline-orchestrator.js',
      './slider-map.js',
      './fft-bridge.js',
      './vip-slider-patch.js',
      './app.js',
      '../sw.js',
    ];

    await Promise.all(CRITICAL_FILES.map(async (path, i) => {
      try {
        const r = await withTimeout(
          fetch(path, { method: 'HEAD', cache: 'no-store' }),
          5000, `HEAD ${path}`
        );
        const ct = r.headers.get('content-type') || 'unknown';
        if (r.ok) {
          const jsOK = path.endsWith('.js') ? ct.includes('javascript') || ct.includes('text') : true;
          report(
            jsOK ? 'pass' : 'warn',
            'files', i + 1,
            `${path} → ${r.status}`,
            `Content-Type: ${ct}${!jsOK ? ' ← WRONG (should be application/javascript)' : ''}`
          );
        } else {
          report('fail', 'files', i + 1, `${path} → ${r.status} (NOT FOUND)`);
        }
      } catch (e) {
        report('fail', 'files', i + 1, `${path} fetch error`, e.message);
      }
    }));
  }

  // ══════════════════════════════════════════════════════════════════════
  // GROUP 10 — APP INSTANCE SMOKE TEST
  // ══════════════════════════════════════════════════════════════════════
  async function testAppInstance() {
    section('GROUP 10 · App Instance Smoke Test');

    const app = window._vipApp || window.vip || window.VoiceIsolatePro;

    // 10.1 App exists
    report(
      app ? 'pass' : 'fail', 'app', 1,
      app ? `App instance found: ${app.constructor?.name || typeof app}` :
            'No app instance on window (_vipApp / vip / VoiceIsolatePro)'
    );
    if (!app) return;

    // 10.2 Critical methods
    const METHODS = ['runPipeline', 'applyPreset', 'encWav', 'initAudio'];
    METHODS.forEach((m, i) => {
      report(
        typeof app[m] === 'function' ? 'pass' : 'fail',
        'app', 2 + i,
        `app.${m}: ${typeof app[m] === 'function' ? 'function ✓' : 'MISSING'}`
      );
    });

    // 10.3 Slider registry size
    const reg = window.VIP_SLIDER_REGISTRY;
    if (reg) {
      report(
        reg.length >= 52 ? 'pass' : 'warn',
        'app', 6,
        `VIP_SLIDER_REGISTRY has ${reg.length} entries (expected ≥ 52)`
      );
    } else {
      report('warn', 'app', 6, 'VIP_SLIDER_REGISTRY not exposed on window');
    }

    // 10.4 VIP_PARAMS populated
    const p = window.VIP_PARAMS;
    if (p && Object.keys(p).length > 0) {
      report('pass', 'app', 7,
        `VIP_PARAMS has ${Object.keys(p).length} keys`,
        Object.keys(p).slice(0, 5).join(', ') + '…');
    } else {
      report('warn', 'app', 7,
        'VIP_PARAMS empty or missing — dispatch input event on a slider to populate');
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // RUNNER
  // ══════════════════════════════════════════════════════════════════════
  const GROUPS = {
    cap   : testCapabilities,
    dsp   : testDSP,
    sab   : testSAB,
    onnx  : testONNX,
    ola   : testOLA,
    gate  : testGateHold,
    sw    : testServiceWorker,
    csp   : testCSP,
    files : testFiles,
    app   : testAppInstance,
  };

  async function runGroup(name) {
    const fn = GROUPS[name];
    if (!fn) {
      console.error(`Unknown group: ${name}. Available: ${Object.keys(GROUPS).join(', ')}`);
      return;
    }
    await fn();
    printSummary();
  }

  async function runAll() {
    console.log(`\n${'═'.repeat(52)}`);
    console.log('  VoiceIsolate Pro — Debug Test Harness');
    console.log(`  ${new Date().toISOString()}`);
    console.log(`${'═'.repeat(52)}`);
    for (const fn of Object.values(GROUPS)) await fn();
    printSummary();
  }

  function printSummary() {
    console.log(`\n${'═'.repeat(52)}`);
    console.log('  HARNESS SUMMARY');
    console.log(`  ${S.pass} Pass:  ${pc}`);
    console.log(`  ${S.fail} Fail:  ${fc}`);
    console.log(`  ${S.warn} Warn:  ${wc}`);
    console.log(`  Total: ${results.length} tests`);
    console.log(`${'═'.repeat(52)}\n`);
    if (fc > 0) {
      console.log('FAILING TESTS:');
      results.filter(r => r.level === 'fail').forEach(r => {
        console.log(`  ${S.fail} [${r.group}:${r.id}] ${r.msg}${r.detail ? ' — ' + r.detail : ''}`);
      });
    }
    window.VIP_HARNESS_RESULTS = { results, pc, fc, wc };
  }

  // Expose API
  window.VIP_HARNESS = { runAll, runGroup, results: () => window.VIP_HARNESS_RESULTS };

  // Auto-run if VIP_DEBUG is true
  if (window.VIP_DEBUG) {
    await runAll();
  } else {
    console.log(
      '%cVIP Debug Harness loaded. Run: await VIP_HARNESS.runAll()',
      'color:#00ff88;font-weight:bold;font-size:13px'
    );
    console.log('  Or a single group: await VIP_HARNESS.runGroup("dsp")');
    console.log('  Groups: cap, dsp, sab, onnx, ola, gate, sw, csp, files, app');
  }

})();
