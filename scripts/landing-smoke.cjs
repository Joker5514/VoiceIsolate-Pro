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

/* global document — used only inside page.evaluate (browser context) */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');

/** Bind to an ephemeral port when SMOKE_PORT is unset — avoids stale listeners. */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

async function resolveSmokePort() {
  if (process.env.SMOKE_PORT) return Number(process.env.SMOKE_PORT);
  return getFreePort();
}

function waitForServer(base, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(`${base}/`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error(`server did not start (${base})`));
      else setTimeout(ping, 250);
    };
    ping();
  });
}

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

async function waitForLandingBoot(page) {
  await page.waitForFunction(() => {
    const legacy = document.getElementById('statusText')?.textContent || '';
    const pill = document.getElementById('statusPillMount')?.textContent || '';
    const text = (legacy || pill).trim();
    const input = document.getElementById('fileInput');
    return text.includes('Idle') && input && !input.disabled;
  }, null, { timeout: 30000 });
}

async function triggerFileIngest(page, wavPath) {
  await page.setInputFiles('#fileInput', wavPath);
  // Playwright usually fires `change`, but dispatch explicitly to avoid races
  // when the ESM bundle finishes loading right as the file is attached.
  await page.locator('#fileInput').dispatchEvent('change');
}

async function waitForPipelineStart(page, consoleErrors) {
  try {
    await page.waitForFunction(
      () => {
        const el = document.getElementById('statusText') || document.getElementById('statusPillMount');
        const text = (el?.textContent || '').trim();
        return text.includes('Decoding')
          || text.includes('Separating')
          || text.includes('isolation')
          || text.includes('Stems ready');
      },
      null, { timeout: 60000 }
    );
  } catch (err) {
    const status = await page.evaluate(() => {
      const legacy = document.getElementById('statusText')?.textContent || '';
      const pill = document.getElementById('statusPillMount')?.textContent || '';
      return (legacy || pill).trim();
    });
    const inputState = await page.evaluate(() => {
      const input = document.getElementById('fileInput');
      return { disabled: input?.disabled ?? null, files: input?.files?.length ?? 0 };
    });
    const detail = [
      `status="${status}"`,
      `fileInput.disabled=${inputState.disabled}`,
      `fileInput.files=${inputState.files}`,
      consoleErrors.length ? `console=${consoleErrors.slice(0, 3).join(' | ')}` : '',
    ].filter(Boolean).join('; ');
    throw new Error(`pipeline did not start within 60s (${detail})`);
  }
}

async function main() {
  const wavPath = makeWav();
  const PORT = await resolveSmokePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`\n🔊 VoiceIsolate Pro — Landing E2E smoke (${BASE})\n`);

  // ── Server ────────────────────────────────────────────────────────────────
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { server.kill('SIGTERM'); } catch { /* noop */ }
    setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* noop */ } }, 2000).unref();
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  await waitForServer(BASE);

  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const statusMsg = () => page.evaluate(() => {
    const el = document.getElementById('statusText') || document.getElementById('statusPillMount');
    return (el?.textContent || '').trim();
  });

  try {
    // ── Load page ───────────────────────────────────────────────────────────
    console.log('Page load:');
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await waitForLandingBoot(page);
    check(await page.title() === 'VoiceIsolate Pro — Stem-Split & Live-Mix', 'title correct');
    for (const id of ['noiseReductionSlider', 'voiceLevelSlider', 'volumeSlider',
      'eqLowSlider', 'eqHighSlider', 'presetSelect', 'waveCanvas', 'specCanvas',
      'muteVoiceBtn', 'muteNoiseBtn', 'speakersPanel', 'speakerCardsGrid']) {
      check(await page.locator(`#${id}`).count() === 1, `#${id} present`);
    }
    // Live-Mix sliders start disabled (no stems to mix yet) so they are never
    // clickable-but-inert before processing.
    const mixSliderIds = ['noiseReductionSlider', 'voiceLevelSlider', 'volumeSlider', 'eqLowSlider', 'eqHighSlider'];
    check(
      await page.evaluate((ids) => ids.every((id) => document.getElementById(id).disabled), mixSliderIds),
      'Live-Mix sliders disabled before processing'
    );

    // ── Ingest + true inference ─────────────────────────────────────────────
    // Landing auto-starts separation after decode (no separate "Ready:" gate).
    console.log('\nIngestion & inference (real model, no passthrough):');
    await triggerFileIngest(page, wavPath);
    await waitForPipelineStart(page, consoleErrors);
    check(true, 'file accepted and pipeline started');

    await page.waitForFunction(
      () => {
        const el = document.getElementById('statusText') || document.getElementById('statusPillMount');
        return el && (el.textContent || '').includes('Stems ready');
      },
      null, { timeout: 180000 }
    );
    const statusAfter = await statusMsg();
    check(!statusAfter.includes('passthrough') && !statusAfter.includes('unavailable'),
      'REAL inference produced stems (not passthrough)');
    check(statusAfter.includes('calibrated'), `auto-calibration applied (“${statusAfter}”)`);
    check(await page.evaluate(() => Boolean(globalThis.__vipDiagnostics?.mixer)), 'mixer + diagnostics exposed');
    check(
      await page.evaluate((ids) => ids.every((id) => !document.getElementById(id).disabled), mixSliderIds),
      'Live-Mix sliders enabled once stems are ready'
    );

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
        eqMid: m.eqMid.gain.value, compRatio: m.compressor.ratio.value,
        gateThresh: m._gateParams?.threshold ?? m.gate?.parameters?.get('threshold')?.value,
        deEssAmt: m._deEsserParams?.amount ?? m.deEsser?.parameters?.get('amount')?.value,
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

    const rtSweep = [
      ['eqMidSlider', 6, 'eqMid', 6],
      ['compRatioSlider', 4, 'compRatio', 4],
      ['deEsserAmountSlider', 25, 'deEssAmt', 0.25],
    ];
    for (const [id, v, key, expected] of rtSweep) {
      await drive(id, v);
      await page.waitForTimeout(350);
      const p = await params();
      const tol = key === 'deEssAmt' ? 0.06 : (Math.abs(expected) > 2 ? 1.5 : 0.06);
      const actual = p[key];
      if (actual == null) {
        check(false, `${id}=${v} → ${key} (worklet not loaded yet)`);
      } else {
        check(near(actual, expected, tol), `${id}=${v} → ${key} ${actual.toFixed(3)} (expect ${expected})`);
      }
    }

    // Rewind so mute/preset checks run from a known transport state.
    await page.click('#stopBtn');
    await page.click('#playBtn');
    await page.waitForTimeout(300);

    // ── Presets ─────────────────────────────────────────────────────────────
    console.log('\nPresets:');
    for (const [name, expectNoise, expectClean] of [
      ['residual-monitor', 1.0, 0.0],
      ['original', 1.0, 1.0],
      ['voice-clarity', 0.0, 1.15],
      ['whisper-boost', 0.15, 1.4],
    ]) {
      await page.selectOption('#presetSelect', name);
      await page.evaluate(() => {
        document.getElementById('presetSelect').dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(400);
      const p = await params();
      check(near(p.noise, expectNoise) && near(p.clean, expectClean),
        `preset '${name}' → noise ${p.noise.toFixed(2)} / voice ${p.clean.toFixed(2)}`);
    }

    // ── Stem mute toggles ───────────────────────────────────────────────────
    console.log('\nStem mute toggles:');
    const cleanBeforeMute = await page.evaluate(
      () => globalThis.__vipDiagnostics.mixer.cleanGain.gain.value);
    await page.click('#muteVoiceBtn');
    await page.waitForTimeout(350);
    let mute = await page.evaluate(() => {
      const m = globalThis.__vipDiagnostics.mixer;
      return { v: m.voiceMuteGain.gain.value, n: m.noiseMuteGain.gain.value,
        vm: m.isVoiceMuted(), clean: m.cleanGain.gain.value };
    });
    check(mute.vm && near(mute.v, 0), `Mute Voice → voice lane ${mute.v.toFixed(3)} (expect 0)`);
    check(near(mute.clean, cleanBeforeMute),
      `Voice Level slider untouched by mute (${mute.clean.toFixed(2)} = pre-mute ${cleanBeforeMute.toFixed(2)})`);
    check(near(mute.n, 1.0), 'noise lane unaffected');
    check((await page.getAttribute('#muteVoiceBtn', 'aria-checked')) === 'true',
      'voice mute switch aria-checked=true');

    await page.click('#muteVoiceBtn');
    await page.click('#muteNoiseBtn');
    await page.waitForTimeout(350);
    mute = await page.evaluate(() => {
      const m = globalThis.__vipDiagnostics.mixer;
      return { v: m.voiceMuteGain.gain.value, n: m.noiseMuteGain.gain.value, nm: m.isNoiseMuted() };
    });
    check(near(mute.v, 1.0), 'unmute restores voice lane to 1');
    check(mute.nm && near(mute.n, 0), `Mute Background → noise lane ${mute.n.toFixed(3)} (expect 0)`);
    await page.click('#muteNoiseBtn');
    await page.waitForTimeout(200);

    // ── Per-speaker isolation ───────────────────────────────────────────────
    console.log('\nPer-speaker isolation:');
    await page.waitForFunction(
      () => /detected|unavailable|skipped/i.test(document.getElementById('speakerStatus').textContent),
      null, { timeout: 90000 }
    );
    const speakerStatus = await page.textContent('#speakerStatus');
    check(!(await page.evaluate(() => document.getElementById('speakersPanel').hidden)),
      'speakers panel revealed after processing');
    check(!/unavailable|skipped/i.test(speakerStatus), `diarization completed (“${speakerStatus}”)`);

    const spk = await page.evaluate(() => {
      const m = globalThis.__vipDiagnostics.mixer;
      return { ids: m.speakerIds(), segments: m.getSpeakerSegments().length,
        cards: document.querySelectorAll('.speaker-card').length };
    });
    check(spk.ids.length >= 1, `speakers detected (${spk.ids.join(', ') || 'none'})`);
    check(spk.segments >= 1, `segments loaded into mixer (${spk.segments})`);
    check(spk.cards === spk.ids.length, `one card per speaker (${spk.cards})`);

    if (spk.ids.length >= 1) {
      await page.click('.speaker-card .speaker-mute-btn');
      const muted = await page.evaluate(() => {
        const m = globalThis.__vipDiagnostics.mixer;
        return m.getSpeakerState(m.speakerIds()[0]).muted;
      });
      check(muted, 'speaker mute button drives mixer state');
      await page.click('.speaker-card .speaker-mute-btn'); // restore

      await page.click('.speaker-card .speaker-solo-btn');
      const solo = await page.evaluate(() => globalThis.__vipDiagnostics.mixer.getSoloSpeaker());
      check(solo === spk.ids[0], `solo button sets exclusive solo (${solo})`);
      await page.click('.speaker-card .speaker-solo-btn'); // clear
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
    cleanup();
  }

  console.log(`\n${failures === 0 ? '✅ Landing E2E: ALL CHECKS PASSED' : `❌ Landing E2E: ${failures} check(s) failed`}\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('[landing-smoke] fatal:', e); process.exit(1); });
