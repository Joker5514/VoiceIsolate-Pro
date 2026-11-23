/**
 * speaker-diarizer.js — ONNX speaker diarization for VoiceIsolate Pro
 *
 * Pipeline (100% local, 16 kHz analysis rate):
 *   Resample → Silero VAD → pyannote segmentation → WeSpeaker embeddings
 *   → agglomerative cosine clustering → SpeakerTimeline
 *
 * Requires global `ort` (onnxruntime-web 1.25.1) for Tensor construction.
 * Pure-JS Kaldi fbank for WeSpeaker features (Worker-safe, no WASM dep).
 */
'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────

const ANALYSIS_SR = 16000;

// Silero VAD v5 (official get_speech_timestamps defaults). The graph takes
// 512 new samples at 16 kHz with the previous chunk's last 64 samples prepended
// ([1, 576]) and a recurrent state carried between chunks. Without the context
// the model returns ~0.003–0.16 on clear speech.
const SILERO_CHUNK = 512;
const SILERO_CONTEXT = 64;
const VAD_THRESHOLD = 0.5;
const VAD_NEG_THRESHOLD = 0.35; // max(threshold - 0.15, 0.01)
const MIN_SPEECH_MS = 250;
const MIN_SILENCE_MS = 100;
const SPEECH_PAD_MS = 30;

// pyannote segmentation 3.0: one frame per 270 samples (16.875 ms) at 16 kHz,
// trained on 10 s chunks, 7 powerset classes (0 = none, 1–3 = one speaker,
// 4–6 = overlapping pairs).
const SEG_FRAME_SAMPLES = 270;
const SEG_WINDOW_SAMPLES = 10 * ANALYSIS_SR;
const SEG_MIN_WINDOW_SAMPLES = 4000;
const POWERSET_SINGLE = Object.freeze({ 1: 0, 2: 1, 3: 2 });

// Clustering, calibrated on real two-speaker speech: LibriSpeech dev-clean
// speakers disjoint from the test fixtures, 17 two-speaker and 18 one-speaker
// conversations. Average-linkage cosine threshold 0.30 counted all 35
// correctly; 0.25 and 0.35 each miss one.
const MIN_SEGMENT_MS = 500;   // shorter turn pieces join their neighbour
const MIN_EMBED_MS = 1000;    // shorter segments take a neighbour's label
const CLUSTER_THRESHOLD = 0.3;
const MIN_CLUSTER_SEC = 3;    // smaller clusters merge into the nearest big one
const EMB_DIM = 256;

// WeSpeaker ResNet34 front end = Kaldi fbank (wespeaker compute_fbank,
// torchaudio.compliance.kaldi.fbank): input ×32768, 25/10 ms, DC removal,
// 0.97 pre-emphasis, hamming, 512-pt power spectrum, 80 Kaldi mel bins from
// 20 Hz to Nyquist, log floor FLT_EPSILON; then per-segment CMN.
const MEL_BANDS = 80;
const MEL_WIN_SAMPLES = 400;
const MEL_HOP_SAMPLES = 160;
const MEL_FFT_SIZE = 512;
const MEL_LOW_HZ = 20;
const PREEMPH = 0.97;
const FLT_EPSILON = 1.1920928955078125e-7;
// WeSpeaker HF preprocessor (onnx-community/wespeaker-voxceleb-resnet34-LM):
// min_num_frames=9.
const MIN_MEL_FRAMES = 9;

const SPEAKER_COLORS = Object.freeze([
  '#4f98a3', '#a86fdf', '#fdab43', '#6daa45', '#dd6974', '#5591c7',
]);

// ─── Kaldi fbank (pure JS, Worker-safe) ─────────────────────────────────────

let _fbankTables = null;
function fbankTables() {
  if (_fbankTables) return _fbankTables;
  const melScale = (f) => 1127 * Math.log(1 + f / 700);
  const win = new Float64Array(MEL_WIN_SAMPLES);
  for (let i = 0; i < MEL_WIN_SAMPLES; i++) {
    win[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (MEL_WIN_SAMPLES - 1));
  }
  // Kaldi MelBanks: num_fft_bins = NFFT / 2 (the Nyquist bin gets no weight).
  const nBins = MEL_FFT_SIZE / 2;
  const melLow = melScale(MEL_LOW_HZ);
  const melHigh = melScale(ANALYSIS_SR / 2);
  const delta = (melHigh - melLow) / (MEL_BANDS + 1);
  const banks = [];
  for (let m = 0; m < MEL_BANDS; m++) {
    const left = melLow + m * delta;
    const center = left + delta;
    const right = center + delta;
    const w = new Float64Array(nBins);
    let first = -1;
    let last = -1;
    for (let i = 0; i < nBins; i++) {
      const mel = melScale((ANALYSIS_SR * i) / MEL_FFT_SIZE);
      if (mel > left && mel < right) {
        w[i] = mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center);
        if (first < 0) first = i;
        last = i;
      }
    }
    banks.push({ first, last, w });
  }
  const cos = new Float64Array(MEL_FFT_SIZE / 2);
  const sin = new Float64Array(MEL_FFT_SIZE / 2);
  for (let i = 0; i < MEL_FFT_SIZE / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / MEL_FFT_SIZE);
    sin[i] = Math.sin((-2 * Math.PI * i) / MEL_FFT_SIZE);
  }
  const rev = new Uint16Array(MEL_FFT_SIZE);
  for (let i = 0, j = 0; i < MEL_FFT_SIZE; i++) {
    rev[i] = j;
    let bit = MEL_FFT_SIZE >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j |= bit;
  }
  _fbankTables = { win, banks, cos, sin, rev };
  return _fbankTables;
}

function fft512(re, im, t) {
  const n = MEL_FFT_SIZE;
  for (let i = 0; i < n; i++) {
    const j = t.rev[i];
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let s = 0; s < n; s += size) {
      for (let k = 0; k < half; k++) {
        const c = t.cos[k * step];
        const sn = t.sin[k * step];
        const a = s + k;
        const b = a + half;
        const xr = re[b] * c - im[b] * sn;
        const xi = re[b] * sn + im[b] * c;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/**
 * Kaldi log-mel fbank for WeSpeaker (no CMN; see applyCmn).
 * @param {Float32Array} pcm  mono @ 16 kHz in [-1, 1]
 * @returns {Float32Array[]}  array of [80] frames (snip_edges framing)
 */
function computeLogMelFrames(pcm) {
  const frames = [];
  if (pcm.length < MEL_WIN_SAMPLES) return frames;
  const t = fbankTables();
  const nFrames = 1 + Math.floor((pcm.length - MEL_WIN_SAMPLES) / MEL_HOP_SAMPLES);
  const re = new Float64Array(MEL_FFT_SIZE);
  const im = new Float64Array(MEL_FFT_SIZE);
  for (let f = 0; f < nFrames; f++) {
    const off = f * MEL_HOP_SAMPLES;
    let mean = 0;
    for (let i = 0; i < MEL_WIN_SAMPLES; i++) {
      re[i] = pcm[off + i] * 32768;
      mean += re[i];
    }
    mean /= MEL_WIN_SAMPLES;
    for (let i = 0; i < MEL_WIN_SAMPLES; i++) re[i] -= mean;
    for (let i = MEL_WIN_SAMPLES - 1; i > 0; i--) re[i] -= PREEMPH * re[i - 1];
    re[0] -= PREEMPH * re[0];
    for (let i = 0; i < MEL_WIN_SAMPLES; i++) re[i] *= t.win[i];
    re.fill(0, MEL_WIN_SAMPLES);
    im.fill(0);
    fft512(re, im, t);
    const mel = new Float32Array(MEL_BANDS);
    for (let m = 0; m < MEL_BANDS; m++) {
      const { first, last, w } = t.banks[m];
      let e = 0;
      for (let i = first; i <= last; i++) e += w[i] * (re[i] * re[i] + im[i] * im[i]);
      mel[m] = Math.log(Math.max(e, FLT_EPSILON));
    }
    frames.push(mel);
  }
  return frames;
}

/** Cepstral mean normalisation across frames (in place). */
function applyCmn(frames) {
  if (!frames.length) return frames;
  const mean = new Float64Array(MEL_BANDS);
  for (const fr of frames) for (let m = 0; m < MEL_BANDS; m++) mean[m] += fr[m];
  for (let m = 0; m < MEL_BANDS; m++) mean[m] /= frames.length;
  for (const fr of frames) for (let m = 0; m < MEL_BANDS; m++) fr[m] -= mean[m];
  return frames;
}

function l2Normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n > 1e-12) for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// ─── Math helpers ────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na * nb);
  return denom > 1e-12 ? dot / denom : 0;
}

/**
 * Agglomerative clustering by average-linkage cosine similarity.
 * Similarities are computed once; merged rows use the Lance–Williams
 * average-linkage update, so a merge equals the mean of member pairs.
 * @param {Float32Array[]} embeddings
 * @param {number} threshold  merge while best pair similarity ≥ threshold
 * @returns {number[]}  cluster label per embedding index
 */
function agglomerativeCluster(embeddings, threshold) {
  const n = embeddings.length;
  if (n === 0) return [];
  if (n === 1) return [0];
  const sim = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosineSimilarity(embeddings[i], embeddings[j]);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }
  const size = new Array(n).fill(1);
  const alive = new Array(n).fill(true);
  const parent = Array.from({ length: n }, (_, i) => i);
  for (;;) {
    let best = -Infinity;
    let bi = -1;
    let bj = -1;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (alive[j] && sim[i][j] > best) { best = sim[i][j]; bi = i; bj = j; }
      }
    }
    if (bi < 0 || best < threshold) break;
    for (let k = 0; k < n; k++) {
      if (!alive[k] || k === bi || k === bj) continue;
      const s = (size[bi] * sim[bi][k] + size[bj] * sim[bj][k]) / (size[bi] + size[bj]);
      sim[bi][k] = s;
      sim[k][bi] = s;
    }
    size[bi] += size[bj];
    alive[bj] = false;
    for (let k = 0; k < n; k++) if (parent[k] === bj) parent[k] = bi;
  }
  const ids = new Map();
  return parent.map((p) => {
    if (!ids.has(p)) ids.set(p, ids.size);
    return ids.get(p);
  });
}

function getOrt() {
  const ort = globalThis.ort;
  if (!ort?.Tensor) {
    throw new Error('[SpeakerDiarizer] onnxruntime-web (ort) is not loaded. Use /lib/ort.min.js v1.25.1.');
  }
  return ort;
}

/**
 * Bind a tensor to the session's first declared input. Hardcoded names
 * (`input`, `feats`) miss the shipped WeSpeaker graph (`input_features`).
 * @param {{ inputNames?: string[] }} session
 * @param {object} tensor
 */
export function sessionFeed(session, tensor) {
  const name = session?.inputNames?.[0];
  if (!name || typeof name !== 'string') {
    throw new Error('[SpeakerDiarizer] ONNX session is missing inputNames[0]');
  }
  return { [name]: tensor };
}

/**
 * Read the session's first declared output, falling back to the sole result key.
 * @param {{ outputNames?: string[] }} session
 * @param {object} result
 */
export function sessionOutput(session, result) {
  const name = session?.outputNames?.[0];
  if (name && result?.[name]) return result[name];
  const keys = result ? Object.keys(result) : [];
  if (!keys.length) {
    throw new Error('[SpeakerDiarizer] ONNX session returned no outputs');
  }
  return result[keys[0]];
}

function padMelFrames(frames, minFrames) {
  if (frames.length >= minFrames) return frames;
  const out = frames.slice();
  const last = out.length ? out[out.length - 1] : new Float32Array(MEL_BANDS);
  while (out.length < minFrames) out.push(new Float32Array(last));
  return out;
}

// ─── SpeakerDiarizer ───────────────────────────────────────────────────────

/**
 * @typedef {Object} SpeakerTimeline
 * @property {Map<string, { id: string, color: string, embedding: Float32Array }>} speakers
 * @property {Array<{ speakerId: string, startSample: number, endSample: number, confidence: number }>} segments
 * @property {number} totalSpeakers
 * @property {number} [analysisSampleRate]
 * @property {number} [totalSamples]
 * @property {number} [durationSec]
 */

export class SpeakerDiarizer {
  /**
   * @param {import('onnxruntime-web').InferenceSession} ortSession_segmentation  pyannote
   * @param {import('onnxruntime-web').InferenceSession} ortSession_embedding     WeSpeaker
   * @param {import('onnxruntime-web').InferenceSession} ortSession_vad          Silero VAD
   * @param {number} [sampleRate=16000]
   */
  constructor(ortSession_segmentation, ortSession_embedding, ortSession_vad, sampleRate = 16000) {
    if (!ortSession_segmentation || !ortSession_embedding || !ortSession_vad) {
      throw new TypeError('[SpeakerDiarizer] All three ONNX sessions are required.');
    }
    this.segSession = ortSession_segmentation;
    this.embSession = ortSession_embedding;
    this.vadSession = ortSession_vad;
    this.sampleRate = sampleRate;
    this._vadState = null;
  }

  /**
   * Resample any AudioBuffer to mono 16 kHz via OfflineAudioContext.
   * @param {AudioBuffer} audioBuffer
   * @returns {Promise<Float32Array>}
   */
  async _resampleTo16k(audioBuffer) {
    const targetSr = this.sampleRate;
    if (audioBuffer.sampleRate === targetSr && audioBuffer.numberOfChannels === 1) {
      return audioBuffer.getChannelData(0).slice();
    }
    const Ctx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!Ctx) throw new Error('[SpeakerDiarizer] OfflineAudioContext unavailable.');
    const outLen = Math.max(1, Math.ceil(audioBuffer.duration * targetSr));
    const ctx = new Ctx(1, outLen, targetSr);
    const srcBuf = ctx.createBuffer(
      audioBuffer.numberOfChannels,
      audioBuffer.length,
      audioBuffer.sampleRate,
    );
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      srcBuf.copyToChannel(audioBuffer.getChannelData(ch), ch);
    }
    const src = ctx.createBufferSource();
    src.buffer = srcBuf;
    src.connect(ctx.destination);
    src.start(0);
    const rendered = await ctx.startRendering();
    return rendered.getChannelData(0).slice();
  }
  /**
   * Silero VAD v5 over full PCM, exactly as the official Python OnnxWrapper:
   * 512-sample chunks, 64 samples of context prepended, state carried.
   * @param {Float32Array} pcm  @ 16 kHz
   * @returns {Promise<Float32Array>} one speech probability per 512-sample chunk
   */
  async _runVAD(pcm) {
    const ort = getOrt();
    let state = new Float32Array(2 * 1 * 128);
    const context = new Float32Array(SILERO_CONTEXT);
    const nChunks = Math.ceil(pcm.length / SILERO_CHUNK);
    const probs = new Float32Array(nChunks);
    const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(ANALYSIS_SR)]), []);
    for (let c = 0; c < nChunks; c++) {
      const start = c * SILERO_CHUNK;
      const input = new Float32Array(SILERO_CONTEXT + SILERO_CHUNK);
      input.set(context, 0);
      const end = Math.min(pcm.length, start + SILERO_CHUNK);
      input.set(pcm.subarray(start, end), SILERO_CONTEXT);
      const result = await this.vadSession.run({
        input: new ort.Tensor('float32', input, [1, SILERO_CONTEXT + SILERO_CHUNK]),
        state: new ort.Tensor('float32', state, [2, 1, 128]),
        sr: srTensor,
      });
      state = new Float32Array(result.stateN.data);
      context.set(input.subarray(input.length - SILERO_CONTEXT));
      probs[c] = Number(result.output.data[0]);
    }
    this._vadState = state;
    return probs;
  }

  /**
   * Speech regions from per-chunk probabilities: a port of silero-vad's
   * get_speech_timestamps (threshold 0.5, neg 0.35, min speech 250 ms,
   * min silence 100 ms, 30 ms padding, no max speech length).
   */
  _vadSpeechRegions(pcm, vadProbs) {
    const ms = ANALYSIS_SR / 1000;
    const minSpeech = MIN_SPEECH_MS * ms;
    const minSilence = MIN_SILENCE_MS * ms;
    const pad = SPEECH_PAD_MS * ms;
    const n = pcm.length;
    const speeches = [];
    let triggered = false;
    let tempEnd = 0;
    let cur = null;
    for (let i = 0; i < vadProbs.length; i++) {
      const p = vadProbs[i];
      const s = i * SILERO_CHUNK;
      if (p >= VAD_THRESHOLD && tempEnd) tempEnd = 0;
      if (p >= VAD_THRESHOLD && !triggered) {
        triggered = true;
        cur = { startSample: s, endSample: 0 };
        continue;
      }
      if (p < VAD_NEG_THRESHOLD && triggered) {
        if (!tempEnd) tempEnd = s;
        if (s - tempEnd < minSilence) continue;
        cur.endSample = tempEnd;
        if (cur.endSample - cur.startSample > minSpeech) speeches.push(cur);
        cur = null;
        tempEnd = 0;
        triggered = false;
      }
    }
    if (cur && n - cur.startSample > minSpeech) {
      cur.endSample = n;
      speeches.push(cur);
    }
    for (let i = 0; i < speeches.length; i++) {
      const sp = speeches[i];
      if (i === 0) sp.startSample = Math.max(0, sp.startSample - pad);
      if (i !== speeches.length - 1) {
        const nx = speeches[i + 1];
        const gap = nx.startSample - sp.endSample;
        if (gap < 2 * pad) {
          sp.endSample += Math.floor(gap / 2);
          nx.startSample = Math.max(0, nx.startSample - Math.floor(gap / 2));
        } else {
          sp.endSample = Math.min(n, sp.endSample + pad);
          nx.startSample = Math.max(0, nx.startSample - pad);
        }
      } else {
        sp.endSample = Math.min(n, sp.endSample + pad);
      }
    }
    return speeches;
  }

  /**
   * Run pyannote on one window (≤ 10 s); powerset argmax per 270-sample frame.
   * @returns {Promise<{ labels: number[], confidences: number[] }>}
   */
  async _runSegmentation(pcm, start, end) {
    const ort = getOrt();
    const seg = pcm.slice(start, end);
    const input = new ort.Tensor('float32', seg, [1, 1, seg.length]);
    const result = await this.segSession.run(sessionFeed(this.segSession, input));
    const logits = sessionOutput(this.segSession, result);
    const data = logits.data;
    const shape = logits.dims || logits.shape || [1, 0, 7];
    const numFrames = shape[1] || 0;
    const numClasses = shape[2] || 7;
    const labels = [];
    const confidences = [];
    for (let f = 0; f < numFrames; f++) {
      let best = 0;
      let maxLogit = -Infinity;
      for (let c = 0; c < numClasses; c++) {
        const v = data[f * numClasses + c];
        if (v > maxLogit) { maxLogit = v; best = c; }
      }
      let sumExp = 0;
      for (let c = 0; c < numClasses; c++) sumExp += Math.exp(data[f * numClasses + c] - maxLogit);
      labels.push(best);
      confidences.push(1 / sumExp);
    }
    return { labels, confidences };
  }

  /**
   * Split one VAD region into single-speaker turns with pyannote, 10 s at a time.
   * Non-speech and overlap frames inherit the current local speaker so they do
   * not fragment a turn (VAD already decided this is speech).
   */
  async _segmentRegion(pcm, start, end) {
    const out = [];
    for (let w0 = start; w0 < end; w0 += SEG_WINDOW_SAMPLES) {
      const w1 = Math.min(end, w0 + SEG_WINDOW_SAMPLES);
      if (w1 - w0 < SEG_MIN_WINDOW_SAMPLES && out.length) {
        out[out.length - 1].endSample = w1;
        continue;
      }
      const { labels, confidences } = await this._runSegmentation(pcm, w0, w1);
      const local = new Array(labels.length);
      let last = -1;
      for (let f = 0; f < labels.length; f++) {
        const spk = POWERSET_SINGLE[labels[f]];
        if (spk !== undefined) last = spk;
        local[f] = last;
      }
      const first = local.find((v) => v >= 0) ?? 0;
      for (let f = 0; f < local.length && local[f] < 0; f++) local[f] = first;
      let k = 0;
      while (k < local.length) {
        let j = k;
        let conf = confidences[k];
        while (j + 1 < local.length && local[j + 1] === local[k]) { j++; conf += confidences[j]; }
        const s0 = w0 + k * SEG_FRAME_SAMPLES;
        const s1 = j === local.length - 1 ? w1 : Math.min(w1, w0 + (j + 1) * SEG_FRAME_SAMPLES);
        out.push({ localLabel: local[k], startSample: s0, endSample: s1, confidence: conf / (j - k + 1) });
        k = j + 1;
      }
      if (!labels.length) out.push({ localLabel: 0, startSample: w0, endSample: w1, confidence: 0 });
    }
    return out;
  }

  /** Join pieces shorter than MIN_SEGMENT_MS to a directly preceding piece. */
  _mergeShortSegments(segments) {
    const minSamples = Math.floor((MIN_SEGMENT_MS / 1000) * this.sampleRate);
    const touch = Math.floor(0.05 * this.sampleRate);
    const out = [];
    for (const s of segments) {
      const prev = out[out.length - 1];
      if (prev && s.endSample - s.startSample < minSamples && s.startSample - prev.endSample < touch) {
        prev.endSample = s.endSample;
      } else {
        out.push({ ...s });
      }
    }
    return out;
  }

  /**
   * L2-normalised WeSpeaker embedding for one PCM slice (Kaldi fbank + CMN).
   * @returns {Promise<Float32Array>}
   */
  async _runEmbedding(pcm, start, end) {
    const ort = getOrt();
    const slice = pcm.subarray(start, end);
    const melFrames = padMelFrames(applyCmn(computeLogMelFrames(slice)), MIN_MEL_FRAMES);
    if (!melFrames.length) return new Float32Array(EMB_DIM);
    const nFrames = melFrames.length;
    const flat = new Float32Array(nFrames * MEL_BANDS);
    for (let f = 0; f < nFrames; f++) flat.set(melFrames[f], f * MEL_BANDS);
    const input = new ort.Tensor('float32', flat, [1, nFrames, MEL_BANDS]);
    const result = await this.embSession.run(sessionFeed(this.embSession, input));
    const out = sessionOutput(this.embSession, result);
    return l2Normalize(new Float32Array(out.data.slice(0, EMB_DIM)));
  }

  /**
   * Diarize cleaned audio (post-iSTFT).
   * @param {AudioBuffer} audioBuffer
   * @returns {Promise<SpeakerTimeline>}
   */
  async diarize(audioBuffer) {
    if (!audioBuffer || typeof audioBuffer.getChannelData !== 'function') {
      throw new TypeError('[SpeakerDiarizer] diarize() requires an AudioBuffer.');
    }
    const empty = (pcm) => ({
      speakers: new Map(),
      segments: [],
      totalSpeakers: 0,
      analysisSampleRate: this.sampleRate,
      totalSamples: pcm.length,
      durationSec: pcm.length / this.sampleRate,
    });

    const pcm = await this._resampleTo16k(audioBuffer);
    const vadProbs = await this._runVAD(pcm);
    const speechRegions = this._vadSpeechRegions(pcm, vadProbs);

    let rawSegments = [];
    for (const region of speechRegions) {
      rawSegments = rawSegments.concat(await this._segmentRegion(pcm, region.startSample, region.endSample));
    }
    rawSegments.sort((a, b) => a.startSample - b.startSample);
    rawSegments = this._mergeShortSegments(rawSegments);
    if (!rawSegments.length) return empty(pcm);

    // Embed segments long enough for a stable WeSpeaker vector.
    const minEmbed = Math.floor((MIN_EMBED_MS / 1000) * this.sampleRate);
    const dur = (s) => s.endSample - s.startSample;
    let embedIdx = rawSegments.map((s, i) => (dur(s) >= minEmbed ? i : -1)).filter((i) => i >= 0);
    if (!embedIdx.length) {
      embedIdx = [rawSegments.reduce((b, s, i) => (dur(s) > dur(rawSegments[b]) ? i : b), 0)];
    }
    const embeddings = [];
    for (const i of embedIdx) {
      embeddings.push(await this._runEmbedding(pcm, rawSegments[i].startSample, rawSegments[i].endSample));
    }
    const labels = agglomerativeCluster(embeddings, CLUSTER_THRESHOLD);

    // Merge clusters with < MIN_CLUSTER_SEC of speech into the most similar big cluster.
    const clusterSec = new Map();
    const centroid = new Map();
    labels.forEach((c, k) => {
      clusterSec.set(c, (clusterSec.get(c) || 0) + dur(rawSegments[embedIdx[k]]) / this.sampleRate);
      const acc = centroid.get(c) || new Float32Array(EMB_DIM);
      for (let d = 0; d < EMB_DIM; d++) acc[d] += embeddings[k][d];
      centroid.set(c, acc);
    });
    centroid.forEach((v) => l2Normalize(v));
    let big = [...clusterSec.keys()].filter((c) => clusterSec.get(c) >= MIN_CLUSTER_SEC);
    if (!big.length) big = [[...clusterSec.keys()].reduce((a, b) => (clusterSec.get(b) > clusterSec.get(a) ? b : a))];
    const remap = new Map();
    for (const c of clusterSec.keys()) {
      if (big.includes(c)) { remap.set(c, c); continue; }
      let bestC = big[0];
      let bestS = -Infinity;
      for (const b of big) {
        const s = cosineSimilarity(centroid.get(c), centroid.get(b));
        if (s > bestS) { bestS = s; bestC = b; }
      }
      remap.set(c, bestC);
    }

    // Segments too short to embed take the label of the nearest embedded segment.
    const cluster = new Array(rawSegments.length).fill(null);
    embedIdx.forEach((i, k) => { cluster[i] = remap.get(labels[k]); });
    for (let i = 0; i < rawSegments.length; i++) {
      if (cluster[i] !== null) continue;
      let bestJ = embedIdx[0];
      for (const j of embedIdx) if (Math.abs(j - i) < Math.abs(bestJ - i)) bestJ = j;
      cluster[i] = cluster[bestJ];
    }

    // Speaker ids in order of first appearance.
    const clusterToGlobal = new Map();
    for (const c of cluster) if (!clusterToGlobal.has(c)) clusterToGlobal.set(c, `S${clusterToGlobal.size + 1}`);

    const speakers = new Map();
    let colorIdx = 0;
    for (const [c, id] of clusterToGlobal) {
      const mean = new Float32Array(EMB_DIM);
      embedIdx.forEach((i, k) => {
        if (cluster[i] !== c) return;
        for (let d = 0; d < EMB_DIM; d++) mean[d] += embeddings[k][d];
      });
      speakers.set(id, { id, color: SPEAKER_COLORS[colorIdx++ % SPEAKER_COLORS.length], embedding: l2Normalize(mean) });
    }

    const segments = rawSegments.map((seg, i) => ({
      speakerId: clusterToGlobal.get(cluster[i]),
      startSample: seg.startSample,
      endSample: Math.min(seg.endSample, pcm.length),
      confidence: seg.confidence,
    }));

    return {
      speakers,
      segments,
      totalSpeakers: speakers.size,
      analysisSampleRate: this.sampleRate,
      totalSamples: pcm.length,
      durationSec: pcm.length / this.sampleRate,
    };
  }


  /**
   * Build a per-sample gain mask for one speaker (0..1) with 5 ms linear ramps.
   * @param {SpeakerTimeline} timeline
   * @param {string} targetSpeakerId
   * @param {number} totalSamples  length at the graph's sample rate
   * @returns {Float32Array}
   */
  buildMaskBuffer(timeline, targetSpeakerId, totalSamples) {
    const mask = new Float32Array(totalSamples);
    const analysisTotal = timeline.totalSamples || totalSamples;
    const scale = totalSamples / Math.max(1, analysisTotal);
    const rampSamples = Math.max(1, Math.floor(0.005 * this.sampleRate * scale));

    for (const seg of timeline.segments || []) {
      if (seg.speakerId !== targetSpeakerId) continue;
      const s0 = Math.floor(seg.startSample * scale);
      const s1 = Math.min(totalSamples, Math.ceil(seg.endSample * scale));
      for (let i = s0; i < s1; i++) mask[i] = 1;
      for (let r = 0; r < rampSamples && s0 + r < s1; r++) {
        mask[s0 + r] = r / rampSamples;
      }
      for (let r = 0; r < rampSamples && s1 - 1 - r >= s0; r++) {
        const idx = s1 - 1 - r;
        mask[idx] = Math.min(mask[idx], r / rampSamples);
      }
    }
    return mask;
  }
}

export {
  MEL_BANDS,
  MEL_WIN_SAMPLES,
  MEL_HOP_SAMPLES,
  MIN_MEL_FRAMES,
  computeLogMelFrames,
  padMelFrames,
};

export default SpeakerDiarizer;
