#!/usr/bin/env node
/**
 * landing-smoke.cjs — VoiceIsolate Pro Stem-Split & Live-Mix E2E smoke test
 *
 * Drives the REAL landing page in headless Chromium against the REAL dev
 * server, real ONNX models, and real Web Audio:
 *
 *   1. Generates a 3 s WAV (voice-band tones + broadband noise)
 *   2. Uploads it, runs true MLWorker inference (no passthrough accepted)
 *   3. Plays the stems and asserts audible output via the AnalyserNode
 *   4. Calibration sweep: drives every slider and asserts the mapped
 *      AudioParam reaches its expected value (±tolerance)
 *   5. Applies every preset and asserts slider + gain state
 *   6. Verifies both visual graphs paint non-blank pixels
 *   7. Transport: pause/stop/seek round-trip
 *
 * Usage: node scripts/landing-smoke.cjs   (exit 0 = all green)
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.SMOKE_PORT || 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
};

// ── 1. Test fixture: 3 s, 48 kHz mono WAV — tones + noise ───────────────────
function makeWav() {
  const sr = 48000, secs = 3, n = sr * secs;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const voice =
      0.35 * Math.sin(2 * Math.PI * 220 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t)) +
      0.18 * Math.sin(2 * Math.PI * 440 * t) +
      0.08 * Math.sin(2 * Math.PI * 880 * t);
    const noise = 0.22 * (Math.random() * 2 - 1);
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round((voice + noise) * 32767 * 0.8)));
  }
  const data = Buffer.from(pcm.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  const file = path.join(os.tmpdir(), 'vip-smoke.wav');
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

async function main() {
  const wavPath = makeWav();
  console.log(`\n🔊 VoiceIsolate Pro — Landing E2E smoke (${BASE})\n`);

  // ── Server ────────────────────────────────────────────────────────────────
  const server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server start timeout')), 15000);
    server.stdout.on('data', (d) => {
      if (String(d).includes('running on port')) { clearTimeout(t); resolve(); }
    });
    server.on('exit', () => reject(new Error('server exited early')));
  });

  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  try {
    // ── Load page ───────────────────────────────────────────────────────────
    console.log('Page load:');
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    check(await page.title() === 'VoiceIsolate Pro — Stem-Split & Live-Mix', 'title correct');
    for (const id of ['noiseReductionSlider', 'voiceLevelSlider', 'volumeSlider',
      'eqLowSlider', 'eqHighSlider', 'presetSelect', 'waveCanvas', 'specCanvas']) {
      check(await page.locator(`#${id}`).count() === 1, `#${id} present`);
    }

    // ── Ingest + true inference ─────────────────────────────────────────────
    console.log('\nIngestion & inference (real model, no passthrough):');
    await page.setInputFiles('#fileInput', wavPath);
    await page.waitForFunction(
      () => document.getElementById('statusText').textContent.startsWith('Ready:'),
      null, { timeout: 30000 }
    );
    check(true, 'file decoded + resampled to 48 kHz');

    await page.click('#processBtn');
    await page.waitForFunction(
      () => document.getElementById('statusText').textContent.includes('Stems ready'),
      null, { timeout: 120000 }
    );
    const statusAfter = await page.textContent('#statusText');
    check(!statusAfter.includes('passthrough') && !statusAfter.includes('unavailable'),
      'REAL inference produced stems (not passthrough)');
    check(await page.evaluate(() => Boolean(globalThis.__vipDiagnostics?.mixer)), 'mixer + diagnostics exposed');

    // Stems must differ from each other and be non-silent (real separation).
    const stemStats = await page.evaluate(() => {
      const m = globalThis.__vipDiagnostics.mixer;
      const c = m.cleanBuffer.getChannelData(0);
      const n = m.noiseBuffer.getChannelData(0);
      const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i += 16) s += a[i] * a[i]; return Math.sqrt(s / (a.length / 16)); };
      return { cleanRms: rms(c), noiseRms: rms(n), len: c.length };
    });
    check(stemStats.cleanRms > 0.01, `clean stem non-silent (rms ${stemStats.cleanRms.toFixed(3)})`);
    check(stemStats.noiseRms > 0.01, `noise stem non-silent (rms ${stemStats.noiseRms.toFixed(3)})`);
    check(stemStats.len === 144000, 'stem length = 3 s @ 48 kHz');

    // ── Playback produces audible output ────────────────────────────────────
    console.log('\nPlayback & live spectrum:');
    await page.click('#playBtn');
    await page.waitForTimeout(900);
    const live = await page.evaluate(() => {
      const m = globalThis.__vipDiagnostics.mixer;
      const a = m.getAnalyser();
      const f = new Uint8Array(a.frequencyBinCount);
      a.getByteFrequencyData(f);
      return { playing: m.isPlaying(), t: m.currentTime(), energy: f.reduce((x, y) => x + y, 0) };
    });
    check(live.playing, 'mixer playing');
    check(live.t > 0.3, `playhead advancing (t=${live.t.toFixed(2)}s)`);
    check(live.energy > 500, `analyser shows audible signal (energy ${live.energy})`);

    const blank = await page.evaluate(() => {
      const px = (id) => {
        const c = document.getElementById(id);
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let nz = 0;
        for (let i = 3; i < d.length; i += 16) if (d[i] > 0) nz++;
        return nz;
      };
      return { wave: px('waveCanvas'), spec: px('specCanvas') };
    });
    check(blank.wave > 100, `waveform graph painted (${blank.wave} px)`);
    check(blank.spec > 100, `spectrum graph painted (${blank.spec} px)`);

    // ── Slider calibration sweep ────────────────────────────────────────────
    console.log('\nSlider calibration (slider → AudioParam):');
    const drive = async (id, value) => page.evaluate(([id, value]) => {
      const el = document.getElementById(id);
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, [id, value]);
    const params = () => page.evaluate(() => {
      const m = globalThis.__vipDiagnostics.mixer;
      return {
        noise: m.noiseGain.gain.value, clean: m.cleanGain.gain.value,
        master: m.masterGain.gain.value, low: m.lowShelf.gain.value, high: m.highShelf.gain.value,
      };
    });
    const near = (a, b, tol = 0.06) => Math.abs(a - b) <= tol;

    const sweep = [
      ['noiseReductionSlider', 0, 'noise', 1.0],
      ['noiseReductionSlider', 50, 'noise', 0.5],
      ['noiseReductionSlider', 100, 'noise', 0.0],
      ['voiceLevelSlider', 0, 'clean', 0.0],
      ['voiceLevelSlider', 200, 'clean', 2.0],
      ['voiceLevelSlider', 100, 'clean', 1.0],
      ['volumeSlider', 25, 'master', 0.25],
      ['volumeSlider', 100, 'master', 1.0],
      ['eqLowSlider', -24, 'low', -24],
      ['eqLowSlider', 12, 'low', 12],
      ['eqHighSlider', 24, 'high', 24],
      ['eqHighSlider', 0, 'high', 0],
    ];
    for (const [id, v, key, expected] of sweep) {
      await drive(id, v);
      await page.waitForTimeout(350); // > 5× the 30 ms smoothing constant
      const p = await params();
      const tol = Math.abs(expected) > 2 ? 1.5 : 0.06; // dB params get dB tolerance
      check(near(p[key], expected, tol), `${id}=${v} → ${key} gain ${p[key].toFixed(3)} (expect ${expected})`);
    }

    // ── Presets ─────────────────────────────────────────────────────────────
    console.log('\nPresets:');
    for (const [name, expectNoise, expectClean] of [
      ['residual-monitor', 1.0, 0.0],
      ['original', 1.0, 1.0],
      ['voice-clarity', 0.0, 1.15],
    ]) {
      await page.selectOption('#presetSelect', name);
      await page.waitForTimeout(350);
      const p = await params();
      check(near(p.noise, expectNoise) && near(p.clean, expectClean),
        `preset '${name}' → noise ${p.noise.toFixed(2)} / voice ${p.clean.toFixed(2)}`);
    }

    // ── Transport round-trip ────────────────────────────────────────────────
    console.log('\nTransport:');
    await page.click('#pauseBtn');
    const pausedAt = await page.evaluate(() => globalThis.__vipDiagnostics.mixer.currentTime());
    await page.waitForTimeout(300);
    const stillPaused = await page.evaluate(() => globalThis.__vipDiagnostics.mixer.currentTime());
    check(Math.abs(pausedAt - stillPaused) < 0.01, `pause holds position (${pausedAt.toFixed(2)}s)`);

    await page.evaluate(() => globalThis.__vipDiagnostics.mixer.seek(1.5));
    check(near(await page.evaluate(() => globalThis.__vipDiagnostics.mixer.currentTime()), 1.5, 0.05),
      'seek(1.5) lands at 1.5 s');

    await page.click('#stopBtn');
    check((await page.evaluate(() => globalThis.__vipDiagnostics.mixer.currentTime())) === 0, 'stop rewinds to 0');

    await page.click('#playBtn');
    await page.waitForTimeout(400);
    check(await page.evaluate(() => globalThis.__vipDiagnostics.mixer.isPlaying()), 'replay after stop works');

    // ── Console hygiene ─────────────────────────────────────────────────────
    console.log('\nConsole hygiene:');
    const realErrors = consoleErrors.filter((e) => !e.includes('favicon'));
    check(realErrors.length === 0, realErrors.length === 0
      ? 'zero console errors'
      : `console errors: ${realErrors.slice(0, 3).join(' | ')}`);
  } finally {
    await browser.close();
    server.kill();
  }

  console.log(`\n${failures === 0 ? '✅ Landing E2E: ALL CHECKS PASSED' : `❌ Landing E2E: ${failures} check(s) failed`}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[landing-smoke] fatal:', e); process.exit(1); });
