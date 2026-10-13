#!/usr/bin/env node
'use strict';
/**
 * Real-Chromium checks for the Live-Mix graph, off-thread DSP and browser
 * storage contracts (repair audit 2026-10-12: F03, F05, F07, F08, F09, F20). Static and mocked tests
 * cannot see Web Audio latency, clipping or IndexedDB commit timing, so this
 * drives the shipped modules in a real browser:
 *
 *   F08  export alignment: impulses at the region's first/last samples and a
 *        cropped region survive renderMix at their own indices
 *   F08  dry/wet: a 50/50 blend of a transparent chain equals the input
 *        (no comb filter), with and without 20 ms gate lookahead
 *   F09  ceiling: no output sample exceeds the set ceiling under +24 dB trim,
 *        +24 dB makeup, 200% voice, 200% width and 50% dry
 *   F07  preview/export: live playback captured from the graph equals
 *        renderMix for the same settings (mute, gains, EQ, dry/wet, speakers)
 *   F03  dispose with a hung worklet fetch resolves and closes the owned context
 *   F20  idbTxDone resolves after a real commit and rejects a real abort
 *   F05  prompted USM runs in a worker: no long main-thread task, output equal
 *        to the direct call, abort settles promptly and frees the worker
 *   F24  the real AudioEncoderWorker output decodes in Chromium at the right
 *        rate/length/values; malformed PCM is rejected through the protocol
 *   F06  (with --fixtures DIR) a short high-bitrate video decodes at its real
 *        duration/pitch, and the forced real-time capture path keeps a click
 *        marker on the decodeAudioData reference sample. Build the fixtures with
 *        scripts/make-decode-fixtures.sh (needs ffmpeg).
 *
 * Usage: start the dev server (node server.js), then
 *   node scripts/runtime-contracts-browser-check.cjs [--base http://localhost:3000] [--json out.json]
 * Exit code 1 on any failed assertion.
 */
const fs = require('fs');
const { launchChromium } = require('./lib/launch-chromium.cjs');

const args = process.argv.slice(2);
const argVal = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = argVal('--base', process.env.VIP_BASE_URL || 'http://localhost:3000');
const JSON_OUT = argVal('--json', null);
const FIXTURES = argVal('--fixtures', null);
const PAGE = `${BASE}/__vip_audio_graph_check__.html`;

async function main() {
  const browser = await launchChromium({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
  // A blank same-origin page so /src modules import exactly as the app does.
  await page.route(PAGE, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>check</title>' }));
  await page.goto(PAGE);

  const results = await page.evaluate(async () => {
    const out = [];
    const check = (id, pass, detail) => out.push({ id, pass: Boolean(pass), detail });
    const { PlaybackMixer, measureCompressorLatency } = await import('/src/pipeline/PlaybackMixer.js');
    const SR = 48000;

    const compFrames = await measureCompressorLatency(SR);
    check('F08 compressor lookahead measured', compFrames > 0 && compFrames < 2048, { frames: compFrames, ms: (compFrames / SR) * 1000 });

    const ctxForBuffers = new OfflineAudioContext(1, 1, SR);
    const bufferFrom = (channels) => {
      const b = ctxForBuffers.createBuffer(channels.length, channels[0].length, SR);
      channels.forEach((c, i) => b.copyToChannel(c, i));
      return b;
    };
    const stats = (buf) => {
      let peak = 0; let nonFinite = 0; let over = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
          const v = d[i];
          if (!Number.isFinite(v)) nonFinite++;
          const a = Math.abs(v);
          if (a > peak) peak = a;
          if (a > 1) over++;
        }
      }
      return { peak, nonFinite, over, length: buf.length, channels: buf.numberOfChannels, sampleRate: buf.sampleRate };
    };
    // PlaybackMixer.dispose() leaves an injected context open (F03), so the
    // check closes every context it creates itself.
    const contexts = [];
    const newMixer = () => {
      const ctx = new AudioContext({ sampleRate: SR });
      contexts.push(ctx);
      return new PlaybackMixer({ context: ctx });
    };

    // ── F08: impulses at the region edges keep their indices ────────────
    {
      const n = SR; // 1 s
      const clean = new Float32Array(n);
      clean[0] = 0.5; clean[1234] = 0.5; clean[n - 1] = 0.5;
      const mixer = newMixer();
      const stems = { clean: bufferFrom([clean]), noise: null };
      const full = await mixer.renderMix({ stems });
      const d = full.getChannelData(0);
      // The default chain is LTI (HP 20 Hz / LP 20 kHz biquads ring), so each
      // impulse's first output sample must be the same value at its own index.
      const v = [d[0], d[1234], d[n - 1]];
      let argmax = 1100;
      for (let i = 1100; i < 1400; i++) if (Math.abs(d[i]) > Math.abs(d[argmax])) argmax = i;
      check('F08 export length equals region', full.length === n, { length: full.length, expected: n });
      check('F08 interior impulse peaks at its own index', argmax === 1234, { argmax });
      // 1e-3 (0.26% of the response): the 20 Hz high-pass tail of a
      // neighbouring impulse adds ~2e-4 by superposition.
      check('F08 edge impulses match the interior response (first, last sample)',
        Math.abs(v[0] - v[1]) < 1e-3 && Math.abs(v[2] - v[1]) < 1e-3 && v[1] > 0.3, { first: v[0], interior: v[1], last: v[2] });
      // Cropped region starting exactly on the interior impulse.
      const crop = await mixer.renderMix({ stems, startSec: 1234 / SR, endSec: 2000 / SR });
      const cd = crop.getChannelData(0);
      check('F08 cropped export starts on the crop-in sample', crop.length === 766 && Math.abs(cd[0] - v[1]) < 1e-3, { length: crop.length, v0: cd[0] });
      await mixer.dispose();
    }

    // ── F08: dry/wet blend of a transparent chain equals the input ──────
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
    const noise = new Float32Array(SR);
    for (let i = 0; i < noise.length; i++) noise[i] = 0.25 * rnd();
    // Band-limit away from the transparent HP (20 Hz) / LP (20 kHz) edges.
    const band = await (async () => {
      const oc = new OfflineAudioContext(1, noise.length, SR);
      const src = oc.createBufferSource(); src.buffer = bufferFrom([noise]);
      const hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 200;
      const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6000;
      src.connect(hp); hp.connect(lp); lp.connect(oc.destination); src.start();
      return (await oc.startRendering()).getChannelData(0).slice();
    })();
    const lagOf = (y, x) => {
      let best = -Infinity; let lag = 0;
      for (let k = -1200; k <= 1200; k++) {
        let s = 0;
        for (let i = 6000; i < 42000; i += 2) s += x[i] * y[i + k];
        if (s > best) { best = s; lag = k; }
      }
      return lag;
    };
    for (const lookahead of [0, 20]) {
      const render = async (dryWet) => {
        const mixer = newMixer();
        await mixer.workletsReady();
        if (lookahead) mixer.setGateLookahead(lookahead);
        mixer.setDryWet(dryWet);
        const r = (await mixer.renderMix({ stems: { clean: bufferFrom([band]), noise: null } })).getChannelData(0).slice();
        const gate = mixer.getWorkletStatus().gate.state;
        await mixer.dispose();
        return { r, gate };
      };
      const wet = await render(100);
      const dry = await render(0);
      const blend = await render(50);
      let err = 0; let ref = 0;
      for (let i = 4800; i < band.length - 4800; i++) { err += (blend.r[i] - band[i]) ** 2; ref += band[i] ** 2; }
      const snr = 10 * Math.log10(ref / Math.max(err, 1e-20));
      const detail = { wetLag: lagOf(wet.r, band), dryLag: lagOf(dry.r, band), blendSnrDb: Number(snr.toFixed(1)), gate: wet.gate };
      check(`F08 dry and wet taps aligned to the input (gate lookahead ${lookahead} ms)`, detail.wetLag === 0 && detail.dryLag === 0, detail);
      // Residual is the transparent HP/LP pair's phase, not a comb filter.
      check(`F08 dry/wet 50% blend tracks the input (gate lookahead ${lookahead} ms)`, snr > 20, detail);
    }

    // ── F09: ceiling holds under every downstream gain ──────────────────
    {
      const n = SR;
      const x = new Float32Array(n);
      for (let i = 0; i < n; i += 2400) x[i] = 0.99;                 // transients
      for (let i = 24000; i < 26400; i++) x[i] = (i % 96 < 48) ? 0.9 : -0.9; // square burst
      const xr = new Float32Array(n); for (let i = 0; i < n; i++) xr[i] = -x[i] * 0.7; // wide stereo
      for (const ceiling of [-6, -1, 0]) {
        const mixer = newMixer();
        mixer.setOutputGain(24); mixer.setMakeupGain(24); mixer.setVoiceLevel(200);
        mixer.setStereoWidth(200); mixer.setDryWet(50); mixer.setLimiterThreshold(ceiling);
        const r = await mixer.renderMix({ stems: { clean: bufferFrom([x, xr]), noise: null } });
        const s = stats(r);
        const c = 10 ** (ceiling / 20);
        check(`F09 output never exceeds ${ceiling} dBFS ceiling`, s.peak <= c + 1e-6 && s.nonFinite === 0, { peak: s.peak, ceiling: c, over: s.over });
        await mixer.dispose();
      }
      // No ceiling set: overs stay visible to Landing's clip validation.
      const mixer = newMixer();
      mixer.setOutputGain(12);
      const r = await mixer.renderMix({ stems: { clean: bufferFrom([x, xr]), noise: null } });
      const s = stats(r);
      check('F09 without a ceiling, over-full-scale samples remain visible', s.over > 0 && s.peak > 1.5, { peak: s.peak, over: s.over });
      await mixer.dispose();
    }

    // ── F07: live playback equals renderMix for the same settings ───────
    {
      const n = SR * 2;
      const voice = new Float32Array(n); const bg = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        // Aperiodic content so cross-correlation has one unambiguous peak.
        voice[i] = 0.3 * Math.sin((2 * Math.PI * (300 + 200 * (i / n)) * i) / SR) * (0.6 + 0.4 * rnd());
        bg[i] = 0.2 * rnd();
      }
      const ctx = new AudioContext({ sampleRate: SR });
      await ctx.resume();
      const mixer = new PlaybackMixer({ context: ctx });
      await mixer.workletsReady();
      mixer.loadStems([voice], [bg]);
      mixer.setNoiseReduction(60); mixer.setVoiceLevel(80); mixer.setLowShelf(6); mixer.setGraphicEq('presence', -4);
      mixer.setDryWet(70); mixer.setNoiseMuted(false);
      mixer.loadSpeakerSegments([{ speakerId: 'A', start: 0.5, end: 1.0 }]);
      mixer.setSpeakerMuted('A', true);
      // Recorder: an AudioWorklet from a blob URL in this test page only.
      const rec = `registerProcessor('vip-test-rec', class extends AudioWorkletProcessor {
        process(inputs) { const i = inputs[0]; if (i && i[0]) this.port.postMessage(i[0].slice(0)); return true; } });`;
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([rec], { type: 'text/javascript' })));
      const tap = new AudioWorkletNode(ctx, 'vip-test-rec', { channelCount: 1, channelCountMode: 'explicit' });
      const chunks = [];
      tap.port.onmessage = (e) => chunks.push(e.data);
      mixer.getAnalyser().connect(tap);
      await mixer.play();
      await new Promise((r) => setTimeout(r, 2600));
      mixer.stop();
      let total = 0; for (const c of chunks) total += c.length;
      const live = new Float32Array(total); let o = 0; for (const c of chunks) { live.set(c, o); o += c.length; }
      const rendered = (await mixer.renderMix({})).getChannelData(0);
      // Align by cross-correlation over a coarse search window.
      const seg = rendered.subarray(SR * 0.2, SR * 0.2 + 9600);
      let best = -Infinity; let lag = 0;
      for (let k = 0; k + seg.length < live.length && k < SR; k++) {
        let s = 0; for (let i = 0; i < seg.length; i += 4) s += seg[i] * live[k + i];
        if (s > best) { best = s; lag = k; }
      }
      const offset = lag - SR * 0.2;
      let err = 0; let ref = 0;
      const from = Math.max(SR * 0.1, -offset); const to = Math.min(rendered.length, live.length - offset) - SR * 0.1;
      for (let i = from; i < to; i++) { err += (live[i + offset] - rendered[i]) ** 2; ref += rendered[i] ** 2; }
      const snr = 10 * Math.log10(ref / Math.max(err, 1e-20));
      // Muted speaker segment 0.5–1.0 s is silent in the export too.
      let segPeak = 0; for (let i = Math.round(SR * 0.55); i < Math.round(SR * 0.95); i++) segPeak = Math.max(segPeak, Math.abs(rendered[i]));
      check('F07 live playback equals renderMix (same settings)', snr > 25 && total > SR, { residualSnrDb: Number(snr.toFixed(1)), capturedFrames: total, liveOffsetFrames: offset });
      // Voice muted there; what remains is 40% of the 0.2-peak background,
      // through +6 dB low shelf and the 30% dry tap: bounded well below voice.
      let voicePeak = 0; for (let i = Math.round(SR * 1.1); i < Math.round(SR * 1.5); i++) voicePeak = Math.max(voicePeak, Math.abs(rendered[i]));
      check('F07 muted speaker segment drops the voice in the export', segPeak < 0.5 * voicePeak, { segPeak, voicePeak });
      await mixer.dispose();
      await ctx.close();
    }

    // ── F03: dispose with a hung worklet fetch ──────────────────────────
    {
      const mixer = new PlaybackMixer();
      const ctx = mixer.ctx;
      const t0 = performance.now();
      await Promise.race([mixer.dispose(), new Promise((r) => setTimeout(r, 2000))]);
      const ms = performance.now() - t0;
      check('F03 dispose resolves with worklet fetch hung', ms < 1500 && ctx.state === 'closed', { ms: Math.round(ms), state: ctx.state, gate: mixer.getWorkletStatus().gate.state });
      const injected = new AudioContext({ sampleRate: SR });
      const m2 = new PlaybackMixer({ context: injected });
      await m2.dispose();
      check('F03 injected context left open', injected.state !== 'closed', { state: injected.state });
      await injected.close();
    }
    await Promise.all(contexts.map((c) => (c.state === 'closed' ? null : c.close().catch(() => {}))));

    // ── F20: real IndexedDB commit / abort ──────────────────────────────
    {
      const idb = await import('/src/core/storage/openIdb.js');
      const name = `vip-check-${Date.now()}`;
      const db = await idb.openIdb(name, 1, (d) => d.createObjectStore('s'));
      const tx = idb.idbTransaction(db, 's', 'readwrite');
      let committedBeforeResolve = null;
      tx.addEventListener('complete', () => { committedBeforeResolve = true; });
      await idb.idbPut(tx.objectStore('s'), new Uint8Array(1 << 20), 'k');
      // A slow caller: awaits unrelated work before asking for completion.
      await new Promise((r) => setTimeout(r, 50));
      await idb.idbTxDone(tx);
      const readTx = db.transaction('s', 'readonly');
      const got = await idb.idbGet(readTx.objectStore('s'), 'k');
      check('F20 idbTxDone resolves after a real commit (late caller)', committedBeforeResolve === true && got?.length === 1 << 20, { committedBeforeResolve, bytes: got?.length });
      const tx2 = idb.idbTransaction(db, 's', 'readwrite');
      await idb.idbPut(tx2.objectStore('s'), 1, 'k2');
      tx2.abort();
      let rejected = null;
      try { await idb.idbTxDone(tx2); rejected = false; } catch (e) { rejected = e?.name || true; }
      const after = await idb.idbGet(db.transaction('s', 'readonly').objectStore('s'), 'k2');
      check('F20 idbTxDone rejects an abort after a successful put', rejected && after === undefined, { rejected, after });
      db.close();
      indexedDB.deleteDatabase(name);
    }
    return out;
  });

  // F03 with addModule stalled forever, in a second page.
  const page2 = await browser.newPage();
  await page2.route(PAGE, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>check</title>' }));
  // Worklet module fetches bypass page routing, so stall addModule itself.
  await page2.addInitScript(() => {
    AudioWorklet.prototype.addModule = () => new Promise(() => {});
  });
  await page2.goto(PAGE);
  const hung = await page2.evaluate(async () => {
    const { PlaybackMixer } = await import('/src/pipeline/PlaybackMixer.js');
    const mixer = new PlaybackMixer();
    await new Promise((r) => setTimeout(r, 300));
    const loading = mixer.getWorkletStatus();
    const ctx = mixer.ctx;
    const t0 = performance.now();
    const outcome = await Promise.race([mixer.dispose().then(() => 'disposed'), new Promise((r) => setTimeout(() => r('hung'), 3000))]);
    return { outcome, ms: Math.round(performance.now() - t0), state: ctx.state, loading };
  });
  results.push({
    id: 'F03 dispose bounded while addModule fetch never answers',
    pass: hung.outcome === 'disposed' && hung.state === 'closed' && hung.loading.gate.state === 'pending',
    detail: hung,
  });

  // F05 — prompted isolation's USM pass off the main thread.
  const page3 = await browser.newPage();
  await page3.route(PAGE, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>check</title>' }));
  await page3.goto(PAGE);
  const f05 = await page3.evaluate(async () => {
    const out = [];
    const check = (id, pass, detail) => out.push({ id, pass: Boolean(pass), detail });
    const { runPromptedIsolation } = await import('/src/pipeline/PromptedIsolation.js');
    const { separateUniversal } = await import('/src/core/UniversalSourceMatrix.js');
    const SR = 48000;
    const n = SR * 20;
    const pcm = new Float32Array(n);
    let seed = 9;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) - 0.5;
    for (let i = 0; i < n; i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.1 * rnd();
    const longTasks = [];
    const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push(e.duration); });
    obs.observe({ type: 'longtask', buffered: false });
    let maxGap = 0;
    let last = performance.now();
    const beat = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 10);
    const t0 = performance.now();
    const res = await runPromptedIsolation({ audio: pcm, sampleRate: SR, prompt: 'speech', output: 'both', samMode: 'onnx-local' });
    const elapsed = performance.now() - t0;
    clearInterval(beat);
    await new Promise((r) => setTimeout(r, 50));
    obs.disconnect();
    const worst = longTasks.length ? Math.max(...longTasks) : 0;
    check('F05 prompted USM leaves the main thread responsive', worst < 200 && maxGap < 200,
      { elapsedMs: Math.round(elapsed), worstLongTaskMs: Math.round(worst), maxTimerGapMs: Math.round(maxGap), provider: res.providerId });
    const direct = separateUniversal(pcm, SR, { mode: 'query', queries: ['speech'], fftSize: 4096, hopSize: 1024 });
    const ref = direct.sources.find((s) => !/residual/i.test(s.label)).pcm;
    let maxDiff = 0;
    for (let i = 0; i < ref.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ref[i] - res.target[i]));
    check('F05 worker output equals the direct separateUniversal output', maxDiff === 0 && res.target.length === n, { maxDiff, length: res.target.length });
    const ac = new AbortController();
    const started = runPromptedIsolation({ audio: pcm, sampleRate: SR, prompt: 'speech', samMode: 'onnx-local', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 150));
    const tAbort = performance.now();
    ac.abort();
    let name = null;
    try { await started; } catch (e) { name = e?.name; }
    const cancelMs = performance.now() - tAbort;
    check('F05 abort settles promptly', name === 'AbortError' && cancelMs < 100, { name, cancelMs: Math.round(cancelMs) });
    let budgetMsg = null;
    try { separateUniversal(new Float32Array(SR * 600), SR, { mode: 'auto', numSources: 6 }); } catch (e) { budgetMsg = e.message; }
    check('F05 10-minute input is refused by the working-memory budget', /limited to about \d+ s/.test(budgetMsg || ''), { budgetMsg });
    return out;
  });
  results.push(...f05);

  // F24 — WAV encoder: independent decode + malformed-input rejection.
  const page5 = await browser.newPage();
  await page5.route(PAGE, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>check</title>' }));
  await page5.goto(PAGE);
  const f24 = await page5.evaluate(async () => {
    const out = [];
    const check = (id, pass, detail) => out.push({ id, pass: Boolean(pass), detail });
    // Settles on a result, an error message, a script/runtime error or a
    // 20 s stall, so a broken worker fails the check instead of hanging it.
    const run = (message) => new Promise((resolve) => {
      const w = new Worker('/src/workers/AudioEncoderWorker.js', { type: 'module' });
      const done = (data) => { clearTimeout(timer); w.terminate(); resolve(data); };
      // 'crash' is distinct from the worker's own validation 'error'.
      const timer = setTimeout(() => done({ type: 'crash', error: 'timeout' }), 20000);
      w.onerror = (e) => { e.preventDefault?.(); done({ type: 'crash', error: e.message || 'load failed' }); };
      w.onmessageerror = () => done({ type: 'crash', error: 'messageerror' });
      w.onmessage = ({ data }) => {
        if (data.type === 'ready') { w.postMessage(message); return; }
        if (data.type === 'result' || data.type === 'error') done(data);
      };
    });
    const n = 44101;
    const l = new Float32Array(n); const r = new Float32Array(n);
    for (let i = 0; i < n; i++) { l[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 44100); r[i] = -l[i]; }
    l[100] = 1.4; // one clipped sample
    const res = await run({ type: 'encode', requestId: 1, format: 'wav', sampleRate: 44100, channels: [l, r] });
    if (res.type !== 'result') {
      check('F24 WAV decodes independently at its rate, length and values', false, { worker: res });
    } else {
      const decodeCtx = new AudioContext({ sampleRate: 44100 });
      const decoded = await decodeCtx.decodeAudioData(await res.blob.arrayBuffer());
      await decodeCtx.close();
      const d0 = decoded.getChannelData(0); const d1 = decoded.getChannelData(1);
      let maxErr = 0;
      for (let i = 0; i < n; i++) if (i !== 100) maxErr = Math.max(maxErr, Math.abs(d0[i] - l[i]), Math.abs(d1[i] - r[i]));
      check('F24 WAV decodes independently at its rate, length and values',
        decoded.sampleRate === 44100 && decoded.length === n && decoded.numberOfChannels === 2 && maxErr < 2 / 32767 && res.clippedSamples === 1 && Math.abs(d0[100] - 1) < 1e-4,
        { sampleRate: decoded.sampleRate, length: decoded.length, maxErr, clippedSamples: res.clippedSamples });
    }
    const bad = await Promise.all([
      run({ type: 'encode', requestId: 2, format: 'wav', sampleRate: 48000, channels: [new Float32Array(4), new Float32Array(3)] }),
      run({ type: 'encode', requestId: 3, format: 'wav', sampleRate: 48000, channels: [new Float32Array([0, NaN])] }),
      run({ type: 'encode', requestId: 4, format: 'mp3', sampleRate: 48000, channels: [new Float32Array(4)] }),
    ]);
    check('F24/F23 malformed PCM and MP3 requests are rejected', bad.every((m) => m.type === 'error'), bad.map((m) => m.error));
    return out;
  });
  results.push(...f24);

  if (FIXTURES) {
    const page4 = await browser.newPage();
    await page4.route(PAGE, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body></body>' }));
    for (const f of ['tone440_10s.webm', 'click2s_6s.webm']) {
      await page4.route(`${BASE}/__fx/${f}`, (route) => route.fulfill({ status: 200, contentType: 'video/webm', body: fs.readFileSync(require('path').join(FIXTURES, f)) }));
    }
    await page4.goto(PAGE);
    const f06 = await page4.evaluate(async () => {
      const out = [];
      const check = (id, pass, detail) => out.push({ id, pass: Boolean(pass), detail });
      const { decodeBlobToAudioBuffer } = await import('/src/pipeline/media-decode.js');
      const load = async (f) => { const b = await (await fetch(`/__fx/${f}`)).blob(); return new File([b], f, { type: b.type }); };
      const stats = (buf) => {
        const d = buf.getChannelData(0); let zc = 0; let click = 0;
        for (let i = 1; i < d.length; i++) { if ((d[i - 1] < 0) !== (d[i] < 0)) zc++; if (Math.abs(d[i]) > Math.abs(d[click])) click = i; }
        return { sampleRate: buf.sampleRate, length: buf.length, duration: buf.duration, hz: Math.round(zc / 2 / buf.duration), clickSec: click / buf.sampleRate };
      };
      const tone = stats(await decodeBlobToAudioBuffer(await load('tone440_10s.webm')));
      check('F06 10 s / 5 MB video decodes at 10 s and 440 Hz', Math.abs(tone.duration - 10) < 0.02 && Math.abs(tone.hz - 440) <= 2 && tone.sampleRate === 48000, tone);
      const file = await load('click2s_6s.webm');
      const ref = stats(await new AudioContext({ sampleRate: 48000 }).decodeAudioData(await file.arrayBuffer()));
      const orig = BaseAudioContext.prototype.decodeAudioData;
      BaseAudioContext.prototype.decodeAudioData = () => Promise.reject(new DOMException('forced', 'EncodingError'));
      let cap;
      try { cap = stats(await decodeBlobToAudioBuffer(file)); } finally { BaseAudioContext.prototype.decodeAudioData = orig; }
      const offsetMs = (cap.clickSec - ref.clickSec) * 1000;
      // The element may start its output mid render quantum (128 frames of
      // zero padding, 2.67 ms), which moves the first non-zero sample; 5 ms
      // is under two quanta and far inside lip-sync tolerance (~45 ms).
      check('F06 forced capture path: rate, duration and click alignment', cap.sampleRate === 48000 && Math.abs(cap.duration - ref.duration) < 0.05 && Math.abs(offsetMs) < 5,
        { ref, capture: cap, clickOffsetMs: Number(offsetMs.toFixed(2)) });
      return out;
    });
    results.push(...f06);
  }

  await browser.close();
  let failed = 0;
  for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${JSON.stringify(r.detail)}`);
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ base: BASE, results }, null, 2));
  console.log(failed ? `[runtime-contracts-check] ${failed} failed` : '[runtime-contracts-check] all passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
