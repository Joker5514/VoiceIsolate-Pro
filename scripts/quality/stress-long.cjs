#!/usr/bin/env node
'use strict';

/**
 * VIP-029 — long-recording / resource-exhaustion stress.
 *
 * Processes progressively longer synthetic speech-like signals (repo
 * builders from lib/signals.cjs: source-filter talker + HVAC noise bed
 * at 5 dB SNR — resource behaviour only, NOT quality evidence) through
 * the production MLWorker (same Node harness as the quality gate) and
 * measures wall time, realtime factor, peak RSS, output integrity
 * (length preserved, finite, peak <= 1), event-loop lag during the
 * longest run, repeat-run stability (leak trend), cooperative
 * cancellation, and recovery after an error.
 *
 * Sweep (bounded so one run stays ~10-20 min on a VM-class machine):
 *   60 s  × landing, engineer, maximum, enhance
 *   300 s × landing, engineer, maximum, enhance
 *   900 s × landing, enhance
 *   300 s × landing × 3 repeats (stability trend)
 * Plus: cancel a 900 s enhance run mid-flight (must reject as
 * cancelled, worker must serve the next job), and an empty-channel
 * error followed by a successful small job (recovery).
 *
 * What this does NOT claim: browser/mobile resource classes (this is
 * one VM class — device-matrix work covers the rest), real-speech
 * quality at length (the corpus eval covers quality; long synthetic
 * signals cover scaling), or files beyond the 900 s tested here.
 * Tier caps themselves are covered by tests/stress-long.test.js
 * (evaluateUpload refusals before any read/decode, post-decode budget
 * that throws instead of truncating).
 *
 * Usage: node scripts/quality/stress-long.cjs [--quick]
 * (--quick runs only the 60 s sweep + cancel + recovery.)
 * Output: output/stress-long/report.json + report.md. Exit 1 on any
 * invariant failure, failed cancel, failed recovery, or peak RSS >=
 * 2 GB (the CORPUS_THRESHOLDS.md memory bar, applied here too).
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createMlWorker } = require('./lib/mlworker-node.cjs');
const { profiles } = require('./lib/profiles.cjs');
const S = require('./lib/signals.cjs');
const M = require('./lib/metrics.cjs');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'output', 'stress-long');
const SR = 48000;
const RSS_LIMIT_MB = 2048;

function buildSignal(seconds) {
  const { signal, active } = S.talker({ seconds, seed: 7 });
  const noise = S.hvac(signal.length, 101);
  const { mix } = S.mixAtSnr(signal, noise, 5, active);
  return mix;
}

async function runOne(worker, profile, input, label, opts = {}) {
  const rssSamples = [process.memoryUsage().rss];
  const sampler = setInterval(() => rssSamples.push(process.memoryUsage().rss), 250);
  let maxLagMs = 0;
  let lagTimer = null;
  if (opts.measureLag) {
    let last = Date.now();
    lagTimer = setInterval(() => {
      const now = Date.now();
      maxLagMs = Math.max(maxLagMs, now - last - 50);
      last = now;
    }, 50);
  }
  const t0 = performance.now();
  let out;
  try {
    out = await worker.separate([input], {
      modelIds: profile.modelIds,
      processingConfig: profile.processingConfig,
      sampleRate: SR,
    });
  } finally {
    clearInterval(sampler);
    if (lagTimer) clearInterval(lagTimer);
  }
  const wallMs = performance.now() - t0;
  const clean = out.clean[0];
  const failures = [];
  if (!clean || clean.length !== input.length) failures.push(`length ${clean?.length} != ${input.length}`);
  if (clean && M.nonFinite(clean)) failures.push(`${M.nonFinite(clean)} non-finite samples`);
  if (clean && M.peak(clean) > 1) failures.push(`peak ${M.peak(clean).toFixed(3)} > 1`);
  const peakRssMb = Math.round(Math.max(...rssSamples) / 1048576);
  const row = {
    label,
    chain: profile.id,
    durationSec: input.length / SR,
    wallMs: Math.round(wallMs),
    rtf: Math.round((wallMs / 1000 / (input.length / SR)) * 100) / 100,
    peakRssMb,
    maxLagMs: opts.measureLag ? Math.round(maxLagMs) : null,
    failures,
  };
  console.log(`  ${label} / ${profile.id}: ${row.wallMs} ms (RTF ${row.rtf}), peak RSS ${peakRssMb} MB${opts.measureLag ? `, max loop lag ${row.maxLagMs} ms` : ''}${failures.length ? ` FAILURES: ${failures.join('; ')}` : ''}`);
  return row;
}

async function main() {
  const quick = process.argv.includes('--quick');
  const worker = await createMlWorker();
  const allProfiles = await profiles();
  const byId = Object.fromEntries(allProfiles.map((p) => [p.id, p]));
  let commit = 'unknown';
  try { commit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { /* not a git checkout */ }

  const rows = [];
  const failures = [];
  const sweep = quick
    ? [[60, ['landing', 'engineer', 'maximum', 'enhance']]]
    : [
      [60, ['landing', 'engineer', 'maximum', 'enhance']],
      [300, ['landing', 'engineer', 'maximum', 'enhance']],
      [900, ['landing', 'enhance']],
    ];
  for (const [seconds, chains] of sweep) {
    console.log(`[stress] building ${seconds}s signal…`);
    const input = buildSignal(seconds);
    for (const chain of chains) {
      const row = await runOne(worker, byId[chain], input, `${seconds}s`, {
        measureLag: seconds === 900,
      });
      rows.push(row);
      if (row.failures.length) failures.push(`${row.label}/${chain}: ${row.failures.join('; ')}`);
      if (row.peakRssMb >= RSS_LIMIT_MB) failures.push(`${row.label}/${chain}: peak RSS ${row.peakRssMb} MB >= ${RSS_LIMIT_MB} MB bar`);
    }
    // Release the long buffer before the next duration (bounded buffering
    // in the harness itself: only one long input alive at a time).
  }

  if (!quick) {
    // Stability trend: same 300 s input through landing 3×. A rising
    // wall time or RSS across repeats indicates a leak or unbounded cache.
    console.log('[stress] stability: 300s landing × 3…');
    const input300 = buildSignal(300);
    const repeats = [];
    for (let i = 0; i < 3; i++) {
      const row = await runOne(worker, byId.landing, input300, `300s-repeat-${i + 1}`);
      repeats.push(row);
      rows.push(row);
      if (row.failures.length) failures.push(`repeat-${i + 1}: ${row.failures.join('; ')}`);
    }
    const trend = repeats[2].wallMs / Math.max(1, repeats[0].wallMs);
    console.log(`[stress] repeat wall trend: ${repeats.map((r) => r.wallMs).join(' → ')} ms (ratio ${trend.toFixed(2)})`);
    if (trend > 2) failures.push(`repeat wall trend ratio ${trend.toFixed(2)} > 2`);

    // Cooperative cancellation: start a 900 s enhance run, cancel ~1 s
    // in, require a cancelled rejection, then prove the worker serves
    // the next job (request-scoped cancellation must not poison it).
    console.log('[stress] cancellation: 900s enhance, cancel at ~1s…');
    const input900 = buildSignal(900);
    const pending = worker.separate([input900], {
      modelIds: byId.enhance.modelIds,
      processingConfig: byId.enhance.processingConfig,
      sampleRate: SR,
    });
    await new Promise((r) => setTimeout(r, 1000));
    worker.cancelLast();
    let cancelErr = null;
    try { await pending; } catch (e) { cancelErr = e; }
    const cancelledOk = cancelErr && /cancel/i.test(cancelErr.message);
    console.log(`[stress] cancel result: ${cancelledOk ? `rejected as cancelled (${cancelErr.message})` : cancelErr ? `rejected with unexpected error (${cancelErr.message})` : 'RESOLVED (cancel failed)'}`);
    if (!cancelledOk) failures.push('cancellation did not reject as cancelled');
    const probe = await runOne(worker, byId.landing, buildSignal(4), 'post-cancel-probe');
    rows.push(probe);
    if (probe.failures.length) failures.push(`post-cancel probe: ${probe.failures.join('; ')}`);

    // Error recovery: an unknown model must error, then the next job
    // must still succeed. (An empty channel, by contrast, resolves to
    // empty stems — graceful, not an error — and is pinned in jest.)
    console.log('[stress] error recovery: unknown model, then small job…');
    let modelErr = null;
    try { await worker.separate([buildSignal(2)], { modelIds: ['no-such-model'], sampleRate: SR }); } catch (e) { modelErr = e; }
    console.log(`[stress] unknown-model result: ${modelErr ? `error (${modelErr.message.slice(0, 120)})` : 'NO ERROR (unexpected)'}`);
    if (!modelErr) failures.push('unknown model did not error');
    const after = await runOne(worker, byId.landing, buildSignal(4), 'post-error-probe');
    rows.push(after);
    if (after.failures.length) failures.push(`post-error probe: ${after.failures.join('; ')}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    commit,
    node: process.version,
    worker: 'onnxruntime-web WASM single thread (quality harness)',
    signal: 'synthetic source-filter talker + HVAC bed @ 5 dB SNR (resource behaviour only, not quality evidence)',
    rows,
    failures,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    '# Long-file / resource stress — VIP-029',
    '',
    `Commit \`${commit}\`, Node ${process.version}. Signal: synthetic talker + HVAC @ 5 dB (resource behaviour only).`,
    '',
    '| Input | Chain | Wall (ms) | RTF | Peak RSS (MB) | Max loop lag (ms) |',
    '|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.label} | ${r.chain} | ${r.wallMs} | ${r.rtf} | ${r.peakRssMb} | ${r.maxLagMs ?? '—'} |`),
    '',
    failures.length ? `## Failures\n\n${failures.map((f) => `- ${f}`).join('\n')}` : '## Failures\n\nNone.',
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), `${lines.join('\n')}\n`);
  if (failures.length) {
    console.error(`[stress] FAIL\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`[stress] DONE — ${rows.length} runs → output/stress-long/report.json + report.md`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
