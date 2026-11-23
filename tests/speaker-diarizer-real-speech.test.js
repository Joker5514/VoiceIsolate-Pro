'use strict';

/**
 * ONNX diarization on real speech, using the pinned models through onnxruntime-web
 * (the runtime the app ships).
 *
 * Bug 1, Silero VAD: v5 needs 512-sample chunks at 16 kHz, each with the previous
 * chunk's last 64 samples prepended, and the recurrent state carried from chunk to
 * chunk. Without the context the model returns a probability of ~0.003–0.16 on clear
 * speech, and the VAD found 0 regions. Probabilities must match the official Python
 * wrapper (fixtures/diarization/silero-reference.json).
 *
 * Bug 2, clustering: WeSpeaker needs Kaldi fbank features (input ×32768, pre-emphasis,
 * DC removal, 20 Hz–Nyquist Kaldi mel banks, per-segment CMN). Embeddings are compared
 * by cosine on L2-normalised vectors, with a threshold calibrated on real two-speaker
 * speech. pyannote frames are 270 samples (16.9 ms), not 10 ms.
 */

const fs = require('fs');
const path = require('path');
const { loadOrtWebForNode } = require('./helpers/ort-web-node');
const { SpeakerDiarizer, computeLogMelFrames } = require('../public/app/speaker-diarizer.js');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'diarization');
const MODEL = (n) => path.join(ROOT, 'public', 'models', n);
const VAD_REF = JSON.parse(fs.readFileSync(path.join(FIX, 'silero-reference.json'), 'utf8'));
const FBANK_REF = JSON.parse(fs.readFileSync(path.join(FIX, 'kaldi-fbank-reference.json'), 'utf8'));

function readWav16(file) {
  const b = fs.readFileSync(file);
  let o = 12; let fmt = null; let data = null;
  while (o < b.length) {
    const id = b.toString('ascii', o, o + 4); const sz = b.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(o + 10), sr: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === 'data') data = b.subarray(o + 8, o + 8 + sz);
    o += 8 + sz + (sz & 1);
  }
  expect(fmt).toEqual({ ch: 1, sr: 16000, bits: 16 });
  const x = new Float32Array(data.length / 2);
  for (let i = 0; i < x.length; i += 1) x[i] = data.readInt16LE(2 * i) / 32768;
  return x;
}
const clip = (name) => readWav16(path.join(FIX, `${name}.wav`));
const truth = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8'));
const audioBuffer = (x) => ({ sampleRate: 16000, numberOfChannels: 1, length: x.length, duration: x.length / 16000, getChannelData: () => x });

const CLIPS = ['libri_2spk_mf', 'libri_2spk_mm', 'osr_2talker', 'espeak_2voice', 'libri_1spk_m'];

describe('SpeakerDiarizer on real speech (pinned ONNX models)', () => {
  let ort; let seg; let emb; let vad;
  const fresh = () => new SpeakerDiarizer(seg, emb, vad, 16000);

  beforeAll(async () => {
    ort = await loadOrtWebForNode();
    globalThis.ort = ort;
    const opt = { executionProviders: ['wasm'] };
    [seg, emb, vad] = await Promise.all([
      ort.InferenceSession.create(MODEL('pyannote-segmentation-3.0.onnx'), opt),
      ort.InferenceSession.create(MODEL('wespeaker-resnet34.onnx'), opt),
      ort.InferenceSession.create(MODEL('silero-vad.onnx'), opt),
    ]);
  }, 60000);

  afterAll(async () => {
    await Promise.all([seg, emb, vad].map((s) => s?.release?.()));
    delete globalThis.ort;
  });

  test('pinned Silero I/O contract: input [B, T], state [2, B, 128], int64 sr scalar', () => {
    expect(vad.inputNames).toEqual(['input', 'state', 'sr']);
    expect(vad.outputNames).toEqual(['output', 'stateN']);
  });

  test.each(CLIPS)('Silero probabilities match the official Python wrapper on %s', async (name) => {
    const ref = VAD_REF.clips[name];
    const probs = await fresh()._runVAD(clip(name));
    expect(probs.length).toBe(ref.probs.length);
    let maxDiff = 0; let maxP = 0;
    for (let i = 0; i < probs.length; i += 1) {
      maxDiff = Math.max(maxDiff, Math.abs(probs[i] - ref.probs[i]));
      maxP = Math.max(maxP, probs[i]);
    }
    expect(maxP).toBeGreaterThan(0.9);
    expect(maxDiff).toBeLessThan(0.01);
  }, 60000);

  test.each(CLIPS)('VAD finds the same speech regions as get_speech_timestamps on %s', async (name) => {
    const ref = VAD_REF.clips[name].segments;
    const x = clip(name);
    const d = fresh();
    const regions = d._vadSpeechRegions(x, await d._runVAD(x));
    expect(regions.length).toBeGreaterThan(0);
    expect(regions.length).toBe(ref.length);
    regions.forEach((r, i) => {
      expect(Math.abs(r.startSample - ref[i][0])).toBeLessThanOrEqual(512);
      expect(Math.abs(r.endSample - ref[i][1])).toBeLessThanOrEqual(512);
    });
  }, 60000);

  test('WeSpeaker features match Kaldi fbank (torchaudio) on real speech', () => {
    const x = clip(FBANK_REF.clip.replace(/\.wav$/, '')).subarray(FBANK_REF.startSample, FBANK_REF.startSample + FBANK_REF.length);
    const frames = computeLogMelFrames(x);
    expect(frames.length).toBe(FBANK_REF.frames);
    let maxDiff = 0;
    frames.forEach((row, f) => row.forEach((v, m) => { maxDiff = Math.max(maxDiff, Math.abs(v - FBANK_REF.fbank[f][m])); }));
    expect(maxDiff).toBeLessThan(0.01);
  });

  test.each(CLIPS)('speaker count on %s matches the ground truth', async (name) => {
    const tl = await fresh().diarize(audioBuffer(clip(name)));
    expect(tl.segments.length).toBeGreaterThan(0);
    expect(tl.totalSpeakers).toBe(truth(name).speakers);
  }, 120000);

  test('speaker embeddings are L2-normalised', async () => {
    const x = clip('libri_1spk_m');
    const e = await fresh()._runEmbedding(x, 16000, 48000);
    const norm = Math.sqrt(e.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 4);
  }, 60000);
});
