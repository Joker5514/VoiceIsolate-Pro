#!/usr/bin/env node
'use strict';

/**
 * VIP-031 — speaker-detection baseline.
 *
 * Two legs, kept distinct in the report:
 *
 * 1. Corpus leg (real audio, no turn-level ground truth): run the
 *    shipped diarization on all 36 admitted clips (upsampled 16k→48k,
 *    as the product resamples) and report speaker counts, segment
 *    counts, mean segment duration and mean confidence per class.
 *    The key baseline metric is the false-split rate on the 14 known
 *    single-speaker clips (clean/quiet/whispered): the clusterer forces
 *    k=2–4 by duration, so single speakers are expected to split.
 *    DER cannot be computed here (no turn labels) — and is not faked.
 *
 * 2. Synthetic leg (known ground truth, speech-like proxies from
 *    lib/signals.cjs, not recorded speech): fixtures with exact turn
 *    boundaries, scored with frame-level diarization error rate
 *    (100 ms frames; predicted cluster ids mapped to true speakers by
 *    the better of the two mappings; missed speech, false-alarm
 *    speech, and confusion all counted; denominator = speech frames).
 *    This measures change detection, false splits/merges, and the
 *    short-turn / similar-voice / silence / overlap / noise cases the
 *    issue lists — on fixtures where the truth is known by
 *    construction, not inferred.
 *
 * Known limits of the shipped diarization (measured, not assumed):
 * k is forced (2 for <10 s, 3 for <30 s, 4 beyond), features are only
 * [RMS, zero-crossing rate, flatness], and `confidence` is an
 * energy-weighted number (0.68 + normalized-energy × 0.29), not a
 * speaker-identity certainty. Nothing here treats it as calibrated.
 *
 * Usage: node scripts/quality/diarization-eval.cjs
 * Output: output/diarization-eval/report.json + report.md.
 */
const fs = require('fs');
const path = require('path');
const { createDiarizationWorker } = require('./lib/diarization-node.cjs');
const S = require('./lib/signals.cjs');
// Shared harness helpers (VIP-036 dedup): corpus-eval's WAV reader and
// linear upsampler produce byte-identical output to the local copies
// this file used to carry (verified: same chunk walk, same /32768
// scaling; the general upsampler at ratio 3 reproduces the old exact-3x
// values index-for-index, including the tail fill). corpus-eval.cjs is
// require-safe: its main() runs only under `require.main === module`.
const { readWav, upsampleLinear } = require('./corpus-eval.cjs');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'output', 'diarization-eval');
const SR = 48000;
const FRAME = 0.1; // 100 ms frames for DER

/** Expand segments to per-frame labels (null = no segment covers the frame). */
function frameLabels(segments, durationSec) {
  const n = Math.ceil(durationSec / FRAME);
  const labels = new Array(n).fill(null);
  for (const s of segments) {
    const a = Math.floor(s.start / FRAME);
    const b = Math.min(n, Math.ceil(s.end / FRAME));
    for (let f = a; f < b; f++) labels[f] = s.speakerId;
  }
  return labels;
}

/**
 * DER for a fixture with known per-frame truth (trueLabels: 'A'/'B'/null).
 * Tries both mappings of predicted cluster ids to true speakers and
 * takes the lower error. Missed = speech frame with no segment;
 * false alarm = segment on a silence frame; confusion = wrong speaker.
 */
function der(pred, truth) {
  const clusters = [...new Set(pred.filter((v) => v != null))];
  const maps = [];
  if (clusters.length <= 1) {
    maps.push(new Map(clusters.map((c) => [c, 'A'])));
  } else {
    maps.push(new Map([[clusters[0], 'A'], [clusters[1], 'B']]));
    maps.push(new Map([[clusters[0], 'B'], [clusters[1], 'A']]));
    for (const extra of clusters.slice(2)) {
      maps[0].set(extra, 'A');
      maps[1].set(extra, 'B');
    }
  }
  const speech = truth.filter((t) => t != null).length;
  let best = null;
  for (const map of maps) {
    let missed = 0, fa = 0, conf = 0;
    for (let f = 0; f < truth.length; f++) {
      const t = truth[f];
      const p = pred[f] == null ? null : map.get(pred[f]) || null;
      if (t == null && p != null) fa++;
      else if (t != null && p == null) missed++;
      else if (t != null && p !== t) conf++;
    }
    const err = missed + fa + conf;
    if (best == null || err < best.err) best = { err, missed, fa, conf, der: speech ? err / speech : (err ? 1 : 0) };
  }
  return best;
}

/**
 * Nearest detected LABEL CHANGE to a true boundary (seconds), or null
 * when the diarizer never changes label. Segment starts/ends alone do
 * not count: the >=300 ms filter removes short segments, leaving gaps
 * whose edges look like boundaries but are not detected changes.
 */
function nearestLabelChange(pred, trueBoundary) {
  let best = null;
  for (let f = 1; f < pred.length; f++) {
    if (pred[f] != null && pred[f - 1] != null && pred[f] !== pred[f - 1]) {
      const d = Math.abs(f * FRAME - trueBoundary);
      if (best == null || d < best) best = d;
    }
  }
  return best;
}

function talkerSeconds(seconds, opts) {
  return S.talker({ seconds, ...opts });
}

function buildFixtures() {
  const talkA = talkerSeconds(6, { seed: 11, f0: 125 });
  const talkB = talkerSeconds(6, { seed: 22, f0: 180, formantScale: 1.2 });
  const talkBsim = talkerSeconds(6, { seed: 33, f0: 135, formantScale: 1.0 });
  const fixtures = [];
  const concat = (parts) => {
    const total = parts.reduce((n, p) => n + p.signal.length, 0);
    const out = { signal: new Float32Array(total), active: new Uint8Array(total) };
    let o = 0;
    for (const p of parts) { out.signal.set(p.signal, o); out.active.set(p.active, o); o += p.signal.length; }
    return out;
  };
  const slice = (talk, startSec, endSec) => ({
    signal: talk.signal.subarray(Math.round(startSec * SR), Math.round(endSec * SR)),
    active: talk.active.subarray(Math.round(startSec * SR), Math.round(endSec * SR)),
  });
  const silence = (sec) => ({ signal: new Float32Array(Math.round(sec * SR)), active: new Uint8Array(Math.round(sec * SR)) });
  // Truth per 100 ms frame from the talkers' own activity masks: a frame
  // is speech for a speaker iff that speaker is active anywhere in it.
  // (The first version marked whole turns as speech, which counted the
  // talkers' natural inter-syllable pauses as missed speech.)
  const truthFrom = (parts) => {
    // parts: [{who, start, active}] with active aligned to the fixture.
    const totalSec = parts.reduce((m, p) => Math.max(m, p.start + p.active.length / SR), 0);
    const n = Math.ceil(totalSec / FRAME);
    const t = new Array(n).fill(null);
    for (const p of parts) {
      for (let f = 0; f < n; f++) {
        const a = Math.round(f * FRAME * SR) - Math.round(p.start * SR);
        const b = Math.round((f + 1) * FRAME * SR) - Math.round(p.start * SR);
        let any = false;
        for (let i = Math.max(0, a); i < Math.min(p.active.length, b); i++) if (p.active[i]) { any = true; break; }
        if (any) t[f] = p.who;
      }
    }
    return t;
  };
  // Bridge short silence gaps (< 300 ms, the diarizer's minimum segment
  // length) between same-speaker speech: reference diarization scoring
  // does not penalize a system for failing to split on every
  // inter-syllable pause, and the shipped diarizer's own segments span
  // such pauses. Without bridging, DER mostly measures pause handling
  // instead of speaker assignment. The 0.5 s gap in two-speaker-gap
  // (5 frames) is deliberately NOT bridged.
  const bridge = (t) => {
    const out = [...t];
    let f = 0;
    while (f < out.length) {
      if (out[f] != null) { f++; continue; }
      let e = f;
      while (e < out.length && out[e] == null) e++;
      if (e - f < 3 && f > 0 && e < out.length && out[f - 1] === out[e]) {
        for (let g = f; g < e; g++) out[g] = out[f - 1];
      }
      f = e;
    }
    return out;
  };
  const finish = (id, built, truthParts, boundary) => {
    fixtures.push({ id, pcm: built.signal, truth: bridge(truthFrom(truthParts)), boundary });
  };
  // Two speakers, one clean boundary at 3 s.
  {
    const built = concat([slice(talkA, 0, 3), slice(talkB, 0, 3)]);
    finish('two-speaker', built, [
      { who: 'A', start: 0, active: slice(talkA, 0, 3).active },
      { who: 'B', start: 3, active: slice(talkB, 0, 3).active },
    ], 3);
  }
  // Two speakers with a 0.5 s silence gap.
  {
    const built = concat([slice(talkA, 0, 3), silence(0.5), slice(talkB, 0, 3)]);
    finish('two-speaker-gap', built, [
      { who: 'A', start: 0, active: slice(talkA, 0, 3).active },
      { who: 'B', start: 3.5, active: slice(talkB, 0, 3).active },
    ], 3.5);
  }
  // Similar voices: f0 125 vs 135, same formants.
  {
    const built = concat([slice(talkA, 0, 3), slice(talkBsim, 0, 3)]);
    finish('similar-voices', built, [
      { who: 'A', start: 0, active: slice(talkA, 0, 3).active },
      { who: 'B', start: 3, active: slice(talkBsim, 0, 3).active },
    ], 3);
  }
  // Short turns: alternating 0.6 s turns, 10 turns.
  {
    const parts = [];
    const truthParts = [];
    for (let i = 0; i < 10; i++) {
      const src = i % 2 === 0 ? talkA : talkB;
      const sl = slice(src, 0, 0.6);
      parts.push(sl);
      truthParts.push({ who: i % 2 === 0 ? 'A' : 'B', start: i * 0.6, active: sl.active });
    }
    finish('short-turns', concat(parts), truthParts, null);
  }
  // Single speaker.
  finish('single', { signal: talkA.signal, active: talkA.active }, [{ who: 'A', start: 0, active: talkA.active }], null);
  // Silence only.
  finish('silence', silence(3), [], null);
  // Overlap: both talkers at once. Truth marks frames where either is
  // active as 'A' (primary): the diarizer can only emit one label per
  // frame, so overlap DER is a floor showing the single-label
  // limitation, not a pass/fail.
  {
    const mix = new Float32Array(6 * SR);
    for (let i = 0; i < mix.length; i++) mix[i] = (talkA.signal[i] + talkB.signal[i]) * 0.7;
    const both = new Uint8Array(6 * SR);
    for (let i = 0; i < both.length; i++) both[i] = talkA.active[i] || talkB.active[i];
    finish('overlap', { signal: mix, active: both }, [{ who: 'A', start: 0, active: both }], null);
  }
  // Noise: single talker + HVAC bed @ 5 dB.
  {
    const { mix } = S.mixAtSnr(talkA.signal, S.hvac(talkA.signal.length, 103), 5, talkA.active);
    finish('noise', { signal: mix, active: talkA.active }, [{ who: 'A', start: 0, active: talkA.active }], null);
  }
  return fixtures;
}

async function main() {
  const worker = createDiarizationWorker();
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/quality/corpus/corpus-manifest.json'), 'utf8'));
  const singleClasses = new Set(['clean-speech', 'quiet-speech', 'whispered-speech']);

  console.log('[diarization] corpus leg…');
  const corpusRows = [];
  for (const clip of manifest.clips) {
    const { samples: x16 } = readWav(path.join(ROOT, 'scripts/quality/corpus', clip.path));
    const x48 = upsampleLinear(x16, clip.sampleRate, SR);
    const r = await worker.diarize(x48, SR);
    const segs = r.segments;
    const row = {
      clip: clip.id,
      class: clip.category,
      knownSingleSpeaker: singleClasses.has(clip.category),
      speakerCount: r.speakerCount,
      nSegments: segs.length,
      meanSegDur: segs.length ? segs.reduce((s, g) => s + (g.end - g.start), 0) / segs.length : 0,
      meanConf: segs.length ? segs.reduce((s, g) => s + g.confidence, 0) / segs.length : null,
    };
    corpusRows.push(row);
    console.log(`  ${clip.id} [${clip.category}]: speakers=${row.speakerCount} segs=${row.nSegments} meanDur=${row.meanSegDur.toFixed(2)}s meanConf=${row.meanConf?.toFixed(2) ?? '—'}`);
  }
  const singleRows = corpusRows.filter((r) => r.knownSingleSpeaker);
  const falseSplit = singleRows.filter((r) => r.speakerCount > 1).length;
  console.log(`[diarization] known-single-speaker clips: ${singleRows.length}, reporting >1 speaker: ${falseSplit} (${(100 * falseSplit / singleRows.length).toFixed(0)}% false-split rate)`);

  console.log('[diarization] synthetic leg…');
  const fixtureRows = [];
  for (const fx of buildFixtures()) {
    const r = await worker.diarize(fx.pcm, SR);
    const pred = frameLabels(r.segments, fx.pcm.length / SR);
    const d = der(pred, fx.truth);
    const row = {
      fixture: fx.id,
      speakerCount: r.speakerCount,
      nSegments: r.segments.length,
      der: Math.round(d.der * 1000) / 1000,
      missed: d.missed,
      falseAlarm: d.fa,
      confusion: d.conf,
      boundaryErr: fx.boundary != null ? (nearestLabelChange(pred, fx.boundary) != null ? Math.round(nearestLabelChange(pred, fx.boundary) * 100) / 100 : null) : null,
      meanConf: r.segments.length ? Math.round(r.segments.reduce((s, g) => s + g.confidence, 0) / r.segments.length * 100) / 100 : null,
    };
    fixtureRows.push(row);
    console.log(`  ${fx.id}: speakers=${row.speakerCount} segs=${row.nSegments} DER=${row.der} (missed=${d.missed} fa=${d.fa} conf=${d.conf})${row.boundaryErr != null ? ` boundaryErr=${row.boundaryErr}s` : ''}`);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    commit: (() => { try { return require('child_process').execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'unknown'; } })(),
    method: 'shipped runDiarization via vm harness (public/app/ml-worker.js diarize message)',
    knownLimits: [
      'k forced 2 (<10s), 3 (<30s), 4 (>=30s) — single speakers split by construction',
      'features are only [RMS, zero-crossing rate, flatness] — no spectral envelope/formants',
      'confidence is energy-weighted (0.68 + normEnergy*0.29), not speaker-identity certainty',
    ],
    corpus: { rows: corpusRows, singleSpeakerClips: singleRows.length, falseSplitCount: falseSplit },
    fixtures: fixtureRows,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    '# Speaker-detection baseline — VIP-031',
    '',
    `Method: shipped runDiarization via vm harness. Corpus leg: ${corpusRows.length} clips. Known-single-speaker false-split rate: ${falseSplit}/${singleRows.length}.`,
    '',
    '| Fixture | Speakers | Segments | DER | Missed | False alarm | Confusion | Boundary err |',
    '|---|---|---|---|---|---|---|---|',
    ...fixtureRows.map((r) => `| ${r.fixture} | ${r.speakerCount} | ${r.nSegments} | ${r.der} | ${r.missed} | ${r.falseAlarm} | ${r.confusion} | ${r.boundaryErr ?? '—'} |`),
    '',
    '## Corpus per-class means',
    '',
    '| Class | n | Mean speakers | Mean segments | Mean seg dur (s) | Mean conf |',
    '|---|---|---|---|---|---|',
    ...[...new Set(corpusRows.map((r) => r.class))].map((c) => {
      const rs = corpusRows.filter((r) => r.class === c);
      const m = (f) => (rs.reduce((s, r) => s + f(r), 0) / rs.length).toFixed(2);
      return `| ${c} | ${rs.length} | ${m((r) => r.speakerCount)} | ${m((r) => r.nSegments)} | ${m((r) => r.meanSegDur)} | ${m((r) => r.meanConf ?? 0)} |`;
    }),
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), `${lines.join('\n')}\n`);
  console.log(`[diarization] DONE → output/diarization-eval/report.json + report.md`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
