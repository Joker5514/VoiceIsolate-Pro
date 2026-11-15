/**
 * VoiceIsolate Pro — Speaker detection with ONNX-first, k-means fallback.
 */
'use strict';

import { diarizeChannel, speakerLabel, summarizeSpeakers } from '../core/diarization.js';
import { copyFloat32Channel, createAbortableYield } from './ui-yield.js';
import { createOrtSession, loadOrtRuntime } from './OrtRuntime.js';

const MODEL_URLS = Object.freeze({
  segmentation: '/models/pyannote-segmentation-3.0.onnx',
  embedding: '/models/wespeaker-resnet34.onnx',
  vad: '/models/silero-vad.onnx',
});

const DIAR_MAX_FRAMES = 480;
const DIAR_BUDGET_MS = 8000;
const PARENT_TIMEOUT_MS = 20000;

let _sessions = null;
let _sessionPromise = null;

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    const len = Number(res.headers.get('content-length') || 0);
    return res.ok && len > 100000;
  } catch {
    return false;
  }
}

function diag(level, event, detail) {
  try { globalThis.VIP_liveDiagnostics?.log?.(level, event, detail); } catch { /* ignore */ }
}

async function loadOnnxSessions() {
  if (_sessions) return _sessions;
  if (_sessionPromise) return _sessionPromise;
  const pending = (async () => {
    const runtime = await loadOrtRuntime();
    if (!runtime.ort?.InferenceSession) {
      const err = new Error(runtime.error || 'onnxruntime-web not loaded');
      err.code = 'ort-unavailable';
      throw err;
    }
    const checks = await Promise.all([
      headOk(MODEL_URLS.segmentation),
      headOk(MODEL_URLS.embedding),
      headOk(MODEL_URLS.vad),
    ]);
    if (!checks.every(Boolean)) {
      const err = new Error('Diarization ONNX models not available locally');
      err.code = 'models-unavailable';
      throw err;
    }
    const [seg, emb, vad] = await Promise.all([
      createOrtSession(MODEL_URLS.segmentation, { cacheKey: 'diar-seg' }),
      createOrtSession(MODEL_URLS.embedding, { cacheKey: 'diar-emb' }),
      createOrtSession(MODEL_URLS.vad, { cacheKey: 'diar-vad' }),
    ]);
    _sessions = { seg, emb, vad };
    return _sessions;
  })();
  _sessionPromise = pending;
  try {
    return await pending;
  } catch (err) {
    if (_sessionPromise === pending) _sessionPromise = null;
    throw err;
  }
}

function abortError() {
  return typeof DOMException === 'function'
    ? new DOMException('Speaker detection superseded', 'AbortError')
    : Object.assign(new Error('Speaker detection superseded'), { name: 'AbortError' });
}

function inlineDiarize(samples, sampleRate, signal) {
  const segments = diarizeChannel(samples, sampleRate, {
    maxFrames: DIAR_MAX_FRAMES,
    budgetMs: DIAR_BUDGET_MS,
    signal,
  });
  return { segments, speakers: summarizeSpeakers(segments), stats: segments.stats || null };
}

async function kMeansDiarize(cleanChannel, sampleRate, signal = null) {
  if (signal?.aborted) throw abortError();
  // The transfer copy runs in budgeted slices: one synchronous copy of the
  // clean stem was an 891 ms task for 5 min on a 4x-throttled mobile profile.
  const samples = await copyFloat32Channel(cleanChannel, { yieldBudget: createAbortableYield(signal) });
  if (typeof Worker !== 'function') return inlineDiarize(samples, sampleRate, signal);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const w = new Worker('/src/workers/DiarizationWorker.js', { type: 'module' });
    const requestId = 1;
    const started = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // postMessage transfers samples.buffer, so samples.length is 0 afterward.
    const sampleCount = samples.length;
    const timer = setTimeout(() => {
      const elapsed = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - started);
      done();
      w.terminate();
      const err = new Error(
        `K-means diarization timeout after ${elapsed}ms (samples=${sampleCount}, rate=${sampleRate}, maxFrames=${DIAR_MAX_FRAMES}, budgetMs=${DIAR_BUDGET_MS})`,
      );
      err.code = 'diarization-timeout';
      reject(err);
    }, PARENT_TIMEOUT_MS);
    // A superseded run (file cleared, re-Process) terminates its worker at
    // once instead of finishing a full-file clustering pass nobody will read.
    const onAbort = () => {
      clearTimeout(timer);
      w.terminate();
      reject(abortError());
    };
    const done = () => signal?.removeEventListener?.('abort', onAbort);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    w.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.requestId !== requestId) return;
      clearTimeout(timer);
      done();
      w.terminate();
      if (msg.type === 'segments') resolve(msg);
      else reject(new Error(msg.message || 'Diarization failed'));
    };
    w.onerror = (e) => {
      clearTimeout(timer);
      done();
      w.terminate();
      reject(new Error(e.message || 'Diarization worker error'));
    };
    w.postMessage({
      type: 'diarize',
      requestId,
      samples,
      sampleRate,
      maxFrames: DIAR_MAX_FRAMES,
      budgetMs: DIAR_BUDGET_MS,
    }, [samples.buffer]);
  });
}

function degraded(reason, extra = {}) {
  return {
    segments: extra.segments || [],
    speakers: extra.speakers || [],
    method: extra.method || 'unavailable',
    status: 'degraded',
    reason: reason || 'speaker detection unavailable',
    provider: extra.provider || 'none',
    providerVerified: false,
    stats: extra.stats || null,
  };
}

function timelineToPlaybackSegments(timeline) {
  const analysisSr = timeline.analysisSampleRate || 16000;
  const segments = (timeline.segments || []).map((seg) => ({
    speakerId: seg.speakerId,
    label: speakerLabel(seg.speakerId),
    start: seg.startSample / analysisSr,
    end: seg.endSample / analysisSr,
    confidence: seg.confidence,
  }));
  const speakers = [...(timeline.speakers?.keys?.() || [])].map((id) => ({
    speakerId: id,
    label: speakerLabel(id),
    talkTime: segments
      .filter((s) => s.speakerId === id)
      .reduce((sum, s) => sum + (s.end - s.start), 0),
  }));
  return { segments, speakers };
}

/**
 * Detect speakers on the clean stem. Tries ONNX diarization when models exist.
 * @param {Float32Array[]} clean
 * @param {number} sampleRate
 * @param {{ signal?: AbortSignal }} [opts] aborting terminates the k-means worker
 * @returns {Promise<{ segments: object[], speakers: object[], method: string }>}
 */
export async function detectSpeakers(clean, sampleRate, { signal = null } = {}) {
  const mono = clean?.[0];
  if (!mono?.length) return { segments: [], speakers: [], method: 'none', status: 'ok' };

  const throwIfAborted = () => { if (signal?.aborted) throw abortError(); };
  let onnxReason = 'onnxruntime-web not loaded';
  try {
    throwIfAborted();
    const { seg, emb, vad } = await loadOnnxSessions();
    throwIfAborted();
    const { default: SpeakerDiarizer } = await import('/app/speaker-diarizer.js');
    const diarizer = new SpeakerDiarizer(seg, emb, vad, 16000);
    const ctx = new OfflineAudioContext(1, mono.length, sampleRate);
    const buf = ctx.createBuffer(1, mono.length, sampleRate);
    buf.copyToChannel(mono, 0);
    const timeline = await diarizer.diarize(buf);
    throwIfAborted();
    const mapped = timelineToPlaybackSegments(timeline);
    diag('info', 'speaker.onnx', { segments: mapped.segments.length, speakers: mapped.speakers.length });
    return { ...mapped, method: 'onnx', status: 'ok', providerVerified: true };
  } catch (onnxErr) {
    if (onnxErr?.name === 'AbortError') throw onnxErr;
    onnxReason = onnxErr?.message || String(onnxErr);
    console.warn('[VIP][SpeakerDetection] ONNX path unavailable:', onnxReason);
    diag('warn', 'speaker.onnx-unavailable', { reason: onnxReason, code: onnxErr?.code || null });
  }

  try {
    const km = await kMeansDiarize(mono, sampleRate, signal);
    const truncated = Boolean(km.stats?.truncated);
    diag(truncated ? 'warn' : 'info', 'speaker.kmeans', {
      segments: km.segments?.length || 0,
      speakers: km.speakers?.length || 0,
      truncated,
      frames: km.stats?.frames ?? null,
      elapsedMs: km.stats?.elapsedMs ?? null,
    });
    return degraded(onnxReason, {
      segments: km.segments || [],
      speakers: km.speakers || [],
      method: 'kmeans',
      provider: 'js-kmeans',
      stats: km.stats || null,
    });
  } catch (kmErr) {
    if (kmErr?.name === 'AbortError') throw kmErr;
    const reason = `${onnxReason}; ${kmErr?.message || kmErr}`;
    console.warn('[VIP][SpeakerDetection] k-means fallback failed:', kmErr?.message || kmErr);
    diag('error', 'speaker.failed', { reason });
    return degraded(reason, { method: 'unavailable' });
  }
}

export default { detectSpeakers };