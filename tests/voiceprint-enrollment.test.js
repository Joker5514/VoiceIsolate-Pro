/**
 * 24-D mel voiceprint enrollment.
 *
 * The classic-script helper must match TargetSpeaker.extractLocalVoiceprint.
 * The legacy worker must store that embedding and must not report success
 * when the signal, the module, or ECAPA is missing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const workerCode = fs.readFileSync(path.join(ROOT, 'public/app/ml-worker.js'), 'utf8');
const voiceprintCode = fs.readFileSync(path.join(ROOT, 'public/app/voiceprint-mel.js'), 'utf8');

function speechLike(sampleRate, seconds, amplitude = 0.25) {
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] = amplitude * Math.sin(2 * Math.PI * 140 * t)
      + amplitude * 0.45 * Math.sin(2 * Math.PI * 280 * t)
      + amplitude * 0.2 * Math.sin(2 * Math.PI * 2100 * t);
  }
  return out;
}

function loadClassicVoiceprint() {
  const context = { console };
  context.self = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(voiceprintCode, context);
  return context;
}

function bootWorker() {
  const posted = [];
  const context = { console, navigator: { userAgent: 'node' } };
  context.self = context;
  context.globalThis = context;
  context.postMessage = (msg) => { posted.push(msg); };
  context.importScripts = (url) => {
    if (String(url).endsWith('voiceprint-mel.js')) {
      vm.runInContext(voiceprintCode, context);
      return;
    }
    throw new Error('unexpected importScripts ' + url);
  };
  vm.createContext(context);
  vm.runInContext(workerCode, context);
  return {
    posted,
    send: (data) => context.onmessage({ data }),
    context,
  };
}

function inRealm(realm, signal) {
  const copy = vm.runInContext(
    '(function (values) { var out = new Float32Array(values.length); for (var i = 0; i < values.length; i++) out[i] = values[i]; return out; })',
    realm,
  );
  return copy(signal);
}

function maxAbsDiff(a, b) {
  const n = Math.min(a.length, b.length);
  let m = Math.abs(a.length - b.length);
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('VIPVoiceprint parity with TargetSpeaker', () => {
  let extractLocalVoiceprint;
  let validateEnrollmentSegment;
  let api;
  let realm;

  beforeAll(async () => {
    ({ extractLocalVoiceprint, validateEnrollmentSegment } = await import('../src/core/TargetSpeaker.js'));
    realm = loadClassicVoiceprint();
    api = realm.VIPVoiceprint;
  });

  test('1s speech-like signal matches the canonical 24-D embedding', () => {
    const sr = 16000;
    const signal = speechLike(sr, 1);
    const local = inRealm(realm, signal);
    const got = api.extractLocalVoiceprint(local, sr);
    const expected = extractLocalVoiceprint(signal, sr);
    expect(got.length).toBe(24);
    expect(expected.length).toBe(24);
    expect(maxAbsDiff(got, expected)).toBe(0);
    expect(got.every((v) => Number.isFinite(v))).toBe(true);
    const energy = Array.from(got).reduce((s, v) => s + v * v, 0);
    expect(energy).toBeCloseTo(1, 6);
  });

  test('validation agrees with validateEnrollmentSegment', () => {
    const sr = 16000;
    const signal = speechLike(sr, 1);
    const local = inRealm(realm, signal);
    const got = api.validateEnrollment(local, sr);
    const expected = validateEnrollmentSegment(signal, sr, { startSec: 0, endSec: 1 });
    expect(got.ok).toBe(true);
    expect(expected.ok).toBe(true);
    expect(got.speechRatio).toBeCloseTo(expected.speechRatio, 6);
  });

  test('silence and short clips are rejected by both implementations', () => {
    const sr = 16000;
    const silence = new Float32Array(sr);
    expect(api.validateEnrollment(inRealm(realm, silence), sr).ok).toBe(false);
    expect(validateEnrollmentSegment(silence, sr, { startSec: 0, endSec: 1 }).ok).toBe(false);
    const tiny = speechLike(sr, 0.1);
    expect(api.validateEnrollment(inRealm(realm, tiny), sr).ok).toBe(false);
    expect(validateEnrollmentSegment(tiny, sr, { startSec: 0, endSec: 0.1 }).ok).toBe(false);
  });
});

describe('ml-worker voiceprint enrollment', () => {
  test('enrolls, retrieves, and clears a real 24-D embedding', async () => {
    const { extractLocalVoiceprint } = await import('../src/core/TargetSpeaker.js');
    const worker = bootWorker();
    const sr = 16000;
    const signal = speechLike(sr, 1);
    const expected = extractLocalVoiceprint(signal, sr);

    await worker.send({
      data: undefined,
      type: 'enrollVoiceprint',
      payload: { signal, speakerId: 'S1', sampleRate: sr },
    });

    const enrolled = worker.posted.find((m) => m.type === 'voiceprintEnrolled');
    expect(enrolled).toBeDefined();
    expect(enrolled.payload.status).toBe('enrolled');
    expect(enrolled.payload.method).toBe('mel-24');
    expect(enrolled.payload.dims).toBe(24);
    expect(enrolled.payload.embedding).toHaveLength(24);
    expect(enrolled.payload.embedding.every((v) => Number.isFinite(v))).toBe(true);
    expect(maxAbsDiff(enrolled.payload.embedding, expected)).toBe(0);
    expect(worker.posted.some((m) => m.type === 'voiceprintUnavailable')).toBe(false);

    worker.posted.length = 0;
    await worker.send({ type: 'getVoiceprint', payload: { speakerId: 'S1' } });
    const fetched = worker.posted.find((m) => m.type === 'voiceprint');
    expect(fetched.payload.method).toBe('mel-24');
    expect(fetched.payload.dims).toBe(24);
    expect(maxAbsDiff(fetched.payload.embedding, expected)).toBe(0);

    worker.posted.length = 0;
    await worker.send({ type: 'clearVoiceprint', payload: { speakerId: 'S1' } });
    expect(worker.posted.some((m) => m.type === 'voiceprintCleared')).toBe(true);
    worker.posted.length = 0;
    await worker.send({ type: 'getVoiceprint', payload: { speakerId: 'S1' } });
    expect(worker.posted.find((m) => m.type === 'error').msg).toMatch(/not enrolled/);
  });

  test('rejects empty, short, silent, non-finite, and missing audio', async () => {
    const worker = bootWorker();
    const cases = [
      [{ type: 'enrollVoiceprint', payload: {} }, /no signal/],
      [{ type: 'enrollVoiceprint', payload: { signal: [] } }, /empty signal/],
      [{ type: 'enrollVoiceprint', payload: { signal: [NaN, Infinity, -Infinity] } }, /invalid signal/],
      [{ type: 'enrollVoiceprint', payload: { signal: speechLike(16000, 0.1), sampleRate: 16000 } }, /too short/],
      [{ type: 'enrollVoiceprint', payload: { signal: new Float32Array(16000), sampleRate: 16000 } }, /little speech/],
      [{ type: 'enrollVoiceprint', payload: { signal: new Float32Array(16000 * 13), sampleRate: 16000 } }, /too long/],
    ];
    for (const [msg, pattern] of cases) {
      worker.posted.length = 0;
      await worker.send(msg);
      const err = worker.posted.find((m) => m.type === 'error');
      expect(err).toBeDefined();
      expect(err.msg).toMatch(pattern);
      expect(worker.posted.some((m) => m.type === 'voiceprintEnrolled')).toBe(false);
    }
  });

  test('does not report ECAPA success when the session is absent', async () => {
    const worker = bootWorker();
    await worker.send({
      type: 'enrollVoiceprint',
      payload: { signal: speechLike(16000, 1), sampleRate: 16000, speakerId: 'A', mode: 'ecapa' },
    });
    const unavailable = worker.posted.find((m) => m.type === 'voiceprintUnavailable');
    expect(unavailable).toBeDefined();
    expect(unavailable.payload.status).toBe('unavailable');
    expect(unavailable.payload.model).toBe('ecapa_tdnn');
    expect(worker.posted.some((m) => m.type === 'voiceprintEnrolled')).toBe(false);
    const fallback = worker.posted.find((m) => m.type === 'model_fallback');
    expect(fallback).toBeDefined();
    expect(fallback.status).toBe('fallback');
    expect(String(fallback.using)).toMatch(/mel/);
    expect(String(fallback.reason)).toMatch(/ECAPA/);
  });

  test('missing voiceprint module is unavailable, not enrolled', async () => {
    const posted = [];
    const context = { console };
    context.self = context;
    context.globalThis = context;
    context.postMessage = (msg) => { posted.push(msg); };
    context.importScripts = () => { throw new Error('missing'); };
    vm.createContext(context);
    vm.runInContext(workerCode, context);
    await context.onmessage({
      data: { type: 'enrollVoiceprint', payload: { signal: speechLike(16000, 1), sampleRate: 16000 } },
    });
    expect(posted.find((m) => m.type === 'voiceprintUnavailable').payload.status).toBe('unavailable');
    expect(posted.some((m) => m.type === 'voiceprintEnrolled')).toBe(false);
  });

  test('invalid embedding is not stored as success', async () => {
    const worker = bootWorker();
    worker.context.VIPVoiceprint = {
      BANDS: 24,
      validateEnrollment: () => ({ ok: true }),
      extractLocalVoiceprint: () => new Float32Array(24).fill(NaN),
    };
    await worker.send({
      type: 'enrollVoiceprint',
      payload: { signal: speechLike(16000, 1), sampleRate: 16000, speakerId: 'bad' },
    });
    expect(worker.posted.find((m) => m.type === 'error').msg).toMatch(/invalid embedding/);
    expect(worker.posted.some((m) => m.type === 'voiceprintEnrolled')).toBe(false);
    worker.posted.length = 0;
    await worker.send({ type: 'getVoiceprint', payload: { speakerId: 'bad' } });
    expect(worker.posted.find((m) => m.type === 'error').msg).toMatch(/not enrolled/);
  });

  test('diarization enrollment uses only the requested speaker and computes an embedding', async () => {
    const { extractLocalVoiceprint } = await import('../src/core/TargetSpeaker.js');
    const worker = bootWorker();
    const sr = 16000;
    const signal = speechLike(sr, 1);
    await worker.send({
      type: 'enrollFromDiarization',
      payload: {
        speakerId: 'S1',
        signal,
        sampleRate: sr,
        segments: [{ speakerId: 'S2', start: 0, end: 1 }],
      },
    });
    expect(worker.posted.find((m) => m.type === 'error').msg).toMatch(/no samples for speaker/);
    expect(worker.posted.some((m) => m.type === 'voiceprintEnrolled')).toBe(false);

    worker.posted.length = 0;
    await worker.send({
      type: 'enrollFromDiarization',
      payload: {
        speakerId: 'S1',
        signal,
        sampleRate: sr,
        segments: [{ speakerId: 'S1', start: 0, end: 1 }],
      },
    });
    const enrolled = worker.posted.find((m) => m.type === 'voiceprintEnrolled');
    expect(enrolled.payload.method).toBe('mel-24');
    expect(enrolled.payload.dims).toBe(24);
    expect(maxAbsDiff(enrolled.payload.embedding, extractLocalVoiceprint(signal, sr))).toBe(0);

    worker.posted.length = 0;
    await worker.send({ type: 'enrollFromDiarization', payload: { speakerId: 'S9' } });
    expect(worker.posted.find((m) => m.type === 'error').msg).toMatch(/no signal/);
    expect(worker.posted.some((m) => m.type === 'voiceprintEnrolled')).toBe(false);
  });
});
