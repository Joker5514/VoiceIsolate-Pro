/**
 * VoiceIsolate Pro — Speaker detection with ONNX-first, k-means fallback.
 */
'use strict';

import SpeakerDiarizer from '/app/speaker-diarizer.js';

const MODEL_URLS = Object.freeze({
  segmentation: '/models/pyannote-segmentation-3.0.onnx',
  embedding: '/models/wespeaker-resnet34.onnx',
  vad: '/models/silero-vad.onnx',
});

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

async function loadOnnxSessions() {
  if (_sessions) return _sessions;
  if (_sessionPromise) return _sessionPromise;
  _sessionPromise = (async () => {
    if (typeof globalThis.ort === 'undefined') {
      throw new Error('onnxruntime-web not loaded');
    }
    const checks = await Promise.all([
      headOk(MODEL_URLS.segmentation),
      headOk(MODEL_URLS.embedding),
      headOk(MODEL_URLS.vad),
    ]);
    if (!checks.every(Boolean)) {
      throw new Error('Diarization ONNX models not available locally');
    }
    const opts = { executionProviders: ['wasm'] };
    const [seg, emb, vad] = await Promise.all([
      globalThis.ort.InferenceSession.create(MODEL_URLS.segmentation, opts),
      globalThis.ort.InferenceSession.create(MODEL_URLS.embedding, opts),
      globalThis.ort.InferenceSession.create(MODEL_URLS.vad, opts),
    ]);
    _sessions = { seg, emb, vad };
    return _sessions;
  })();
  return _sessionPromise;
}

function kMeansDiarize(cleanChannel, sampleRate) {
  return new Promise((resolve, reject) => {
    const w = new Worker('/src/workers/DiarizationWorker.js', { type: 'module' });
    const requestId = 1;
    const timer = setTimeout(() => {
      w.terminate();
      reject(new Error('K-means diarization timeout'));
    }, 60000);
    const samples = new Float32Array(cleanChannel);
    w.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.requestId !== requestId) return;
      clearTimeout(timer);
      w.terminate();
      if (msg.type === 'segments') resolve(msg);
      else reject(new Error(msg.message || 'Diarization failed'));
    };
    w.onerror = (e) => {
      clearTimeout(timer);
      w.terminate();
      reject(new Error(e.message || 'Diarization worker error'));
    };
    w.postMessage({ type: 'diarize', requestId, samples, sampleRate }, [samples.buffer]);
  });
}

function timelineToPlaybackSegments(timeline) {
  const analysisSr = timeline.analysisSampleRate || 16000;
  const segments = (timeline.segments || []).map((seg) => ({
    speakerId: seg.speakerId,
    start: seg.startSample / analysisSr,
    end: seg.endSample / analysisSr,
    confidence: seg.confidence,
  }));
  const speakers = [...(timeline.speakers?.keys?.() || [])].map((id) => ({
    speakerId: id,
    label: `Speaker ${id}`,
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
 * @returns {Promise<{ segments: object[], speakers: object[], method: string }>}
 */
export async function detectSpeakers(clean, sampleRate) {
  const mono = clean[0];
  if (!mono?.length) return { segments: [], speakers: [], method: 'none' };

  try {
    const { seg, emb, vad } = await loadOnnxSessions();
    const diarizer = new SpeakerDiarizer(seg, emb, vad, 16000);
    const ctx = new OfflineAudioContext(1, mono.length, sampleRate);
    const buf = ctx.createBuffer(1, mono.length, sampleRate);
    buf.copyToChannel(mono, 0);
    const timeline = await diarizer.diarize(buf);
    const mapped = timelineToPlaybackSegments(timeline);
    return { ...mapped, method: 'onnx' };
  } catch (onnxErr) {
    console.warn('[VIP][SpeakerDetection] ONNX path unavailable:', onnxErr.message);
    const km = await kMeansDiarize(mono, sampleRate);
    return { segments: km.segments, speakers: km.speakers, method: 'kmeans' };
  }
}

export default { detectSpeakers };