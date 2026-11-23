'use strict';

/**
 * Loads the pinned wespeaker + pyannote ONNX files with onnxruntime-web
 * (the runtime the repo already pins) and runs a real embedding through
 * SpeakerDiarizer._runEmbedding. A hardcoded input name of `input` or
 * `feats` will fail this test because the shipped model only accepts
 * `input_features`.
 */

const fs = require('fs');
const path = require('path');

const { loadOrtWebForNode } = require('./helpers/ort-web-node');
const {
  SpeakerDiarizer,
  sessionFeed,
  sessionOutput,
  computeLogMelFrames,
  padMelFrames,
  MEL_BANDS,
  MIN_MEL_FRAMES,
} = require('../public/app/speaker-diarizer.js');

let DIARIZATION_MODEL_MANIFEST;

const ROOT = path.join(__dirname, '..');
const WE_SPEAKER = path.join(ROOT, 'public', 'models', 'wespeaker-resnet34.onnx');
const PYANNOTE = path.join(ROOT, 'public', 'models', 'pyannote-segmentation-3.0.onnx');

function tone(seconds = 1, freq = 180, sampleRate = 16000) {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = 0.2 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

describe('SpeakerDiarizer ONNX input binding (real pinned models)', () => {
  let ort;
  let embSession;
  let segSession;
  let diarizer;

  beforeAll(async () => {
    ({ DIARIZATION_MODEL_MANIFEST } = await import('../src/core/DiarizationModelManifest.js'));
    expect(fs.existsSync(WE_SPEAKER)).toBe(true);
    expect(fs.existsSync(PYANNOTE)).toBe(true);
    ort = await loadOrtWebForNode();
    globalThis.ort = ort;
    [embSession, segSession] = await Promise.all([
      ort.InferenceSession.create(WE_SPEAKER, { executionProviders: ['wasm'] }),
      ort.InferenceSession.create(PYANNOTE, { executionProviders: ['wasm'] }),
    ]);
    const dummyVad = { inputNames: ['input', 'state', 'sr'], outputNames: ['output', 'stateN'] };
    diarizer = new SpeakerDiarizer(segSession, embSession, dummyVad);
  }, 60000);

  afterAll(async () => {
    await embSession?.release?.();
    await segSession?.release?.();
    delete globalThis.ort;
  });

  test('pinned wespeaker I/O names and 80-dim fbank layout match the HF pin', () => {
    expect(embSession.inputNames).toEqual(['input_features']);
    expect(embSession.outputNames).toEqual(['last_hidden_state']);
    const inMeta = embSession.inputMetadata[0] || embSession.inputMetadata.input_features;
    const shape = inMeta.shape || inMeta.dims;
    expect(shape[shape.length - 1]).toBe(80);
    expect(MEL_BANDS).toBe(80);
    expect(MIN_MEL_FRAMES).toBe(9);
    expect(DIARIZATION_MODEL_MANIFEST.embedding.inputName).toBe('input_features');
    expect(DIARIZATION_MODEL_MANIFEST.embedding.outputName).toBe('last_hidden_state');
  });

  test('pinned pyannote I/O names bind via inputNames[0] / outputNames[0]', () => {
    expect(segSession.inputNames).toEqual(['input_values']);
    expect(segSession.outputNames).toEqual(['logits']);
    expect(DIARIZATION_MODEL_MANIFEST.segmentation.inputName).toBe('input_values');
    expect(DIARIZATION_MODEL_MANIFEST.segmentation.outputName).toBe('logits');
    const dummy = { data: new Float32Array(10) };
    expect(sessionFeed(segSession, dummy)).toEqual({ input_values: dummy });
    expect(sessionOutput(segSession, { logits: dummy, other: dummy })).toBe(dummy);
  });

  test('sessionFeed uses inputNames[0]; a name mismatch fails the real session', async () => {
    const pcm = tone(0.2);
    const frames = padMelFrames(computeLogMelFrames(pcm), MIN_MEL_FRAMES);
    const flat = new Float32Array(frames.length * MEL_BANDS);
    for (let t = 0; t < frames.length; t += 1) flat.set(frames[t], t * MEL_BANDS);
    const tensor = new ort.Tensor('float32', flat, [1, frames.length, MEL_BANDS]);

    const feed = sessionFeed(embSession, tensor);
    expect(Object.keys(feed)).toEqual(['input_features']);
    expect(feed.input_features).toBe(tensor);

    await expect(embSession.run({ input: tensor })).rejects.toThrow(/input_features/);
    await expect(embSession.run({ feats: tensor })).rejects.toThrow(/input_features/);
  }, 30000);

  test('real wespeaker embedding is a 256-dim finite vector', async () => {
    const pcm = tone(1);
    const emb = await diarizer._runEmbedding(pcm, 0, pcm.length);
    expect(emb).toBeInstanceOf(Float32Array);
    expect(emb.length).toBe(256);
    expect(emb.every((v) => Number.isFinite(v))).toBe(true);
    expect(emb.some((v) => v !== 0)).toBe(true);
  }, 30000);

  test('real pyannote segmentation returns a labels vector via bound I/O names', async () => {
    const pcm = tone(1);
    const { labels, confidences } = await diarizer._runSegmentation(pcm, 0, pcm.length);
    expect(Array.isArray(labels)).toBe(true);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((v) => Number.isFinite(v))).toBe(true);
    expect(confidences).toHaveLength(labels.length);
    expect(confidences.every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
  }, 30000);
});
