/**
 * VoiceIsolate Pro — Speaker detection with ONNX-first, k-means fallback.
 */
'use strict';

import { diarizeChannel, speakerLabel, summarizeSpeakers } from '../core/diarization.js';
import { copyFloat32Channel, createAbortableYield } from './ui-yield.js';
import { __resetOrtSessionsForTests, createOrtSession, loadOrtRuntime } from './OrtRuntime.js';
import {
  DIARIZATION_MODEL_MANIFEST,
  verifyDiarizationModelBytes,
} from '../core/DiarizationModelManifest.js';

const MODEL_URLS = Object.freeze({
  segmentation: '/models/pyannote-segmentation-3.0.onnx',
  embedding: '/models/wespeaker-resnet34.onnx',
  vad: '/models/silero-vad.onnx',
});
/** Exact files and same-origin URLs the ONNX diarizer loads. */
export const DIARIZATION_MODEL_URLS = MODEL_URLS;

const DIAR_MAX_FRAMES = 480;
const DIAR_BUDGET_MS = 8000;
const PARENT_TIMEOUT_MS = 20000;
/** Smaller than any of the three models: a Git LFS pointer or an error page. */
const MIN_MODEL_BYTES = 100000;

let _sessions = null;
let _sessionPromise = null;
/** A model that failed to compile stays failed until reload: no 35 MB retry per pass. */
let _loadFailure = null;

/**
 * HEAD one model. Vercel's edge Brotli-encodes the rewrite to Blob and
 * server.js streams its blob proxy chunked, so a 200 often has no
 * Content-Length. A missing length is unknown, not missing: the session
 * load that follows is what proves the bytes. A length that is present
 * and small is a stub. No Range request: one sent through the Vercel
 * rewrite was cached at the edge and replayed to later full GETs.
 * @param {string} role
 * @param {string} url
 */
async function probeModel(role, url) {
  const file = url.slice(url.lastIndexOf('/') + 1);
  const base = { role, file, url, status: null, contentLength: null, contentEncoding: null };
  let res;
  try {
    res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
  } catch (err) {
    return { ...base, verdict: 'unreachable', detail: err?.message || String(err) };
  }
  const rawLen = res.headers?.get?.('content-length');
  const len = rawLen == null || rawLen === '' ? null : Number(rawLen);
  const out = {
    ...base,
    status: res.status,
    contentLength: Number.isFinite(len) ? len : null,
    contentEncoding: res.headers?.get?.('content-encoding') || null,
  };
  // Only 404/410 say the file is absent. A 401/403/405/429/5xx means the
  // HEAD was refused or failed; existence is unverified (live test t24u:
  // all three models answered 403 from the browser and were logged missing).
  if (!res.ok) return { ...out, verdict: res.status === 404 || res.status === 410 ? 'missing' : 'unverified' };
  if (out.contentLength == null) return { ...out, verdict: 'present-unsized' };
  if (out.contentLength <= MIN_MODEL_BYTES) return { ...out, verdict: 'stub' };
  return { ...out, verdict: 'present' };
}

function describeProbe(m) {
  if (m.verdict === 'missing') return `${m.file} (${m.url}: HTTP ${m.status})`;
  if (m.verdict === 'unverified') return `${m.file} (${m.url}: HTTP ${m.status}, unverified)`;
  if (m.verdict === 'stub') return `${m.file} (${m.url}: ${m.contentLength} bytes, stub)`;
  if (m.verdict === 'unreachable') return `${m.file} (${m.url}: unreachable: ${m.detail})`;
  return `${m.file} (${m.url}: ${m.verdict})`;
}

/**
 * Probe the three diarization models without downloading them.
 * @returns {Promise<{ ok: boolean, models: object[], summary: string }>}
 */
export async function probeDiarizationModels() {
  const models = await Promise.all(
    Object.entries(MODEL_URLS).map(([role, url]) => probeModel(role, url)),
  );
  const bad = models.filter((m) => m.verdict !== 'present' && m.verdict !== 'present-unsized');
  // Every non-present model was only refused at HEAD: a session load (GET) may still work.
  const onlyUnverified = bad.length > 0 && bad.every((m) => m.verdict === 'unverified');
  return { ok: bad.length === 0, onlyUnverified, models, summary: bad.map(describeProbe).join('; ') };
}

/**
 * The ONNX diarizer is opt-in. With the presence probe fixed, a 4:07 file on
 * the local server loaded all three models (WebGPU) and then failed inside
 * speaker-diarizer.js after ~29 s on the main thread ("Session already
 * started" from two passes sharing sessions, then an ORT internal null
 * read). Until that path is validated, the default never downloads the
 * 35 MB of models; it probes them and says exactly why k-means ran.
 * Opt in with localStorage 'vip-onnx-diarization' = '1' or
 * globalThis.VIP_ONNX_DIARIZATION = true.
 */
export function onnxDiarizationEnabled() {
  if (globalThis.VIP_ONNX_DIARIZATION === true) return true;
  try {
    return globalThis.localStorage?.getItem?.('vip-onnx-diarization') === '1';
  } catch {
    return false;
  }
}

/** One ONNX diarization at a time: ORT sessions reject concurrent run(). */
let _onnxQueue = Promise.resolve();
function serialiseOnnx(task) {
  const run = _onnxQueue.then(task, task);
  _onnxQueue = run.then(() => {}, () => {});
  return run;
}

/** Test hook: forget memoised sessions and load failures. */
export function __resetDiarizationModelStateForTests() {
  _sessions = null;
  _sessionPromise = null;
  _loadFailure = null;
  __resetOrtSessionsForTests();
}

function diag(level, event, detail) {
  try { globalThis.VIP_liveDiagnostics?.log?.(level, event, detail); } catch { /* ignore */ }
}

async function loadVerifiedDiarizationSource(entry, url) {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (typeof res.arrayBuffer !== 'function') {
    throw new Error('model GET response has no arrayBuffer()');
  }
  const bytes = await res.arrayBuffer();
  if (entry) await verifyDiarizationModelBytes(entry, bytes);
  return bytes;
}

async function createNamedSession(role, cacheKey) {
  const entry = DIARIZATION_MODEL_MANIFEST[role];
  const url = entry?.url || MODEL_URLS[role];
  try {
    const source = await loadVerifiedDiarizationSource(entry, url);
    return await createOrtSession(source, { cacheKey, quietFailure: true });
  } catch (cause) {
    const file = (entry?.file) || url.slice(url.lastIndexOf('/') + 1);
    const code = cause?.code === 'model-integrity' ? 'model-integrity' : 'model-load-failed';
    const err = new Error(`${file} (${url}): ${cause?.message || cause}`);
    err.code = code;
    err.models = [{ role, file, url, verdict: 'load-failed', detail: cause?.message || String(cause) }];
    throw err;
  }
}

async function loadOnnxSessions() {
  if (_sessions) return _sessions;
  if (_loadFailure) {
    const again = new Error(_loadFailure.message);
    again.code = _loadFailure.code;
    again.models = _loadFailure.models;
    again.cached = true;
    throw again;
  }
  if (_sessionPromise) return _sessionPromise;
  const pending = (async () => {
    const runtime = await loadOrtRuntime();
    if (!runtime.ort?.InferenceSession) {
      const err = new Error(runtime.error || 'onnxruntime-web not loaded');
      err.code = 'ort-unavailable';
      throw err;
    }
    const probe = await probeDiarizationModels();
    if (!probe.ok && !probe.onlyUnverified) {
      const err = new Error(`Diarization ONNX models not available: ${probe.summary}`);
      err.code = 'models-unavailable';
      err.models = probe.models;
      throw err;
    }
    const results = await Promise.allSettled([
      createNamedSession('segmentation', 'diar-seg'),
      createNamedSession('embedding', 'diar-emb'),
      createNamedSession('vad', 'diar-vad'),
    ]);
    const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (failed.length) {
      for (const r of results) {
        if (r.status === 'fulfilled') Promise.resolve(r.value?.release?.()).catch(() => {});
      }
      const err = new Error(`Diarization ONNX model failed to load: ${failed.map((e) => e.message).join('; ')}`);
      err.code = 'model-load-failed';
      err.models = failed.flatMap((e) => e.models || []);
      _loadFailure = err;
      throw err;
    }
    const [seg, emb, vad] = results.map((r) => r.value);
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
    if (!onnxDiarizationEnabled()) {
      const probe = await probeDiarizationModels();
      const reachable = probe.models.filter((m) => m.verdict === 'present' || m.verdict === 'present-unsized').length;
      let message;
      let code;
      if (probe.ok) {
        message = `ONNX diarizer is off by default (models reachable ${reachable}/3; opt in with localStorage vip-onnx-diarization=1)`;
        code = 'onnx-diarizer-disabled';
      } else if (probe.onlyUnverified) {
        message = `ONNX diarizer is off by default; model HEAD refused, presence unverified: ${probe.summary}`;
        code = 'models-unverified';
      } else {
        message = `ONNX diarizer is off by default; models not available: ${probe.summary}`;
        code = 'models-unavailable';
      }
      const err = new Error(message);
      err.code = code;
      err.models = probe.models;
      throw err;
    }
    const timeline = await serialiseOnnx(async () => {
      throwIfAborted();
      const { seg, emb, vad } = await loadOnnxSessions();
      throwIfAborted();
      const { default: SpeakerDiarizer } = await import('/app/speaker-diarizer.js');
      const diarizer = new SpeakerDiarizer(seg, emb, vad, 16000);
      const ctx = new OfflineAudioContext(1, mono.length, sampleRate);
      const buf = ctx.createBuffer(1, mono.length, sampleRate);
      buf.copyToChannel(mono, 0);
      return diarizer.diarize(buf);
    });
    throwIfAborted();
    const mapped = timelineToPlaybackSegments(timeline);
    diag('info', 'speaker.onnx', { segments: mapped.segments.length, speakers: mapped.speakers.length });
    return { ...mapped, method: 'onnx', status: 'ok', providerVerified: true };
  } catch (onnxErr) {
    if (onnxErr?.name === 'AbortError') throw onnxErr;
    onnxReason = onnxErr?.message || String(onnxErr);
    console.warn('[VIP][SpeakerDetection] ONNX path unavailable:', onnxReason);
    diag('warn', 'speaker.onnx-unavailable', {
      reason: onnxReason,
      code: onnxErr?.code || null,
      models: onnxErr?.models || null,
      cached: onnxErr?.cached === true,
    });
    console.warn('[VIP][SpeakerDetection] Falling back to k-means diarization because the ONNX path failed:', onnxReason);
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