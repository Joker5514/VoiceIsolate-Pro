/**
 * speaker-diarizer.js — ONNX speaker diarization for VoiceIsolate Pro
 *
 * Pipeline (100% local, 16 kHz analysis rate):
 *   Resample → Silero VAD → pyannote segmentation → WeSpeaker embeddings
 *   → agglomerative cosine clustering → SpeakerTimeline
 *
 * Requires global `ort` (onnxruntime-web 1.25.1) for Tensor construction.
 * Pure-JS Cooley-Tukey FFT for log-mel features (Worker-safe, no WASM dep).
 */
'use strict';

// ─── Constants ─────────────────────────────────────────────────────────────

const ANALYSIS_SR = 16000;
const FRAME_MS = 10;
const FRAME_SAMPLES = Math.floor(ANALYSIS_SR * FRAME_MS / 1000); // 160 @ 16 kHz
const VAD_THRESHOLD = 0.5;
const MIN_SPEECH_MS = 200;
const MIN_SEGMENT_MS = 500;
const CLUSTER_THRESHOLD = 0.75;
const SILERO_CHUNK = 512;
const MEL_BANDS = 80;
const MEL_WIN_SAMPLES = 400;  // 25 ms @ 16 kHz
const MEL_HOP_SAMPLES = 160;    // 10 ms @ 16 kHz
const MEL_FFT_SIZE = 512;
const MEL_FMIN = 0;
const MEL_FMAX = 8000;

const SPEAKER_COLORS = Object.freeze([
  '#4f98a3', '#a86fdf', '#fdab43', '#6daa45', '#dd6974', '#5591c7',
]);

// ─── Pure-JS radix-2 Cooley-Tukey FFT (power-of-two sizes only) ─────────────

/**
 * In-place iterative Cooley-Tukey FFT.
 * @param {Float32Array} re  real part (length = power of 2)
 * @param {Float32Array} im  imaginary part (same length)
 */
function fftRadix2(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
        const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const nwRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nwRe;
      }
    }
  }
}

/** Magnitude spectrum from real time-domain frame (zero-padded to fftSize). */
function magnitudeSpectrum(frame, fftSize) {
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  const n = Math.min(frame.length, fftSize);
  for (let i = 0; i < n; i++) re[i] = frame[i];
  fftRadix2(re, im);
  const mag = new Float32Array(fftSize / 2 + 1);
  for (let k = 0; k < mag.length; k++) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  }
  return mag;
}

// ─── Mel filterbank (built once per sample rate) ────────────────────────────

function hzToMel(hz) {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel) {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

function buildMelFilterbank(sr, nFft, nMels, fmin, fmax) {
  const nBins = nFft / 2 + 1;
  const melMin = hzToMel(fmin);
  const melMax = hzToMel(fmax);
  const melPts = new Float64Array(nMels + 2);
  for (let i = 0; i < nMels + 2; i++) {
    melPts[i] = melMin + (i * (melMax - melMin)) / (nMels + 1);
  }
  const hzPts = melPts.map(melToHz);
  const binPts = hzPts.map((hz) => Math.floor((nFft + 1) * hz / sr));
  const bank = Array.from({ length: nMels }, () => new Float32Array(nBins));
  for (let m = 1; m <= nMels; m++) {
    const fLeft = binPts[m - 1];
    const fCenter = binPts[m];
    const fRight = binPts[m + 1];
    for (let k = fLeft; k < fCenter && k < nBins; k++) {
      bank[m - 1][k] = (k - fLeft) / Math.max(1, fCenter - fLeft);
    }
    for (let k = fCenter; k < fRight && k < nBins; k++) {
      bank[m - 1][k] = (fRight - k) / Math.max(1, fRight - fCenter);
    }
  }
  return bank;
}

const _melBank = buildMelFilterbank(ANALYSIS_SR, MEL_FFT_SIZE, MEL_BANDS, MEL_FMIN, MEL_FMAX);
const _hannWin = (() => {
  const w = new Float32Array(MEL_WIN_SAMPLES);
  for (let i = 0; i < MEL_WIN_SAMPLES; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (MEL_WIN_SAMPLES - 1)));
  }
  return w;
})();

/**
 * Compute log-mel spectrogram for WeSpeaker input.
 * @param {Float32Array} pcm  mono @ 16 kHz
 * @returns {Float32Array[]}  array of [80] frames
 */
function computeLogMelFrames(pcm) {
  const frames = [];
  if (pcm.length < MEL_WIN_SAMPLES) return frames;
  const nFrames = 1 + Math.floor((pcm.length - MEL_WIN_SAMPLES) / MEL_HOP_SAMPLES);
  const scratch = new Float32Array(MEL_WIN_SAMPLES);
  for (let f = 0; f < nFrames; f++) {
    const off = f * MEL_HOP_SAMPLES;
    for (let i = 0; i < MEL_WIN_SAMPLES; i++) scratch[i] = pcm[off + i] * _hannWin[i];
    const mag = magnitudeSpectrum(scratch, MEL_FFT_SIZE);
    const mel = new Float32Array(MEL_BANDS);
    for (let m = 0; m < MEL_BANDS; m++) {
      let e = 0;
      for (let k = 0; k < mag.length; k++) e += mag[k] * mag[k] * _melBank[m][k];
      mel[m] = Math.log(Math.max(e, 1e-10));
    }
    frames.push(mel);
  }
  return frames;
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
 * @param {Float32Array[]} embeddings
 * @param {number} threshold  merge while best pair similarity ≥ threshold
 * @returns {number[]}  cluster label per embedding index
 */
function agglomerativeCluster(embeddings, threshold) {
  const n = embeddings.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  const clusters = embeddings.map((_, i) => [i]);

  function avgSim(c1, c2) {
    let sum = 0;
    let cnt = 0;
    for (const i of c1) {
      for (const j of c2) {
        sum += cosineSimilarity(embeddings[i], embeddings[j]);
        cnt++;
      }
    }
    return cnt ? sum / cnt : 0;
  }

  while (clusters.length > 1) {
    let best = -1;
    let bi = 0;
    let bj = 1;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const s = avgSim(clusters[i], clusters[j]);
        if (s > best) { best = s; bi = i; bj = j; }
      }
    }
    if (best < threshold) break;
    clusters[bi] = clusters[bi].concat(clusters[bj]);
    clusters.splice(bj, 1);
  }

  const labels = new Array(n);
  clusters.forEach((cl, cid) => cl.forEach((idx) => { labels[idx] = cid; }));
  return labels;
}

function getOrt() {
  const ort = globalThis.ort;
  if (!ort?.Tensor) {
    throw new Error('[SpeakerDiarizer] onnxruntime-web (ort) is not loaded. Use /lib/ort.min.js v1.25.1.');
  }
  return ort;
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
   * Run Silero VAD over full PCM; returns per-10ms-frame speech probabilities.
   * @param {Float32Array} pcm  @ 16 kHz
   * @returns {Promise<Float32Array>}
   */
  async _runVAD(pcm) {
    const ort = getOrt();
    this._vadState = new Float32Array(2 * 1 * 128);
    const nFrames = Math.ceil(pcm.length / FRAME_SAMPLES);
    const probs = new Float32Array(nFrames);

    for (let fi = 0; fi < nFrames; fi++) {
      const start = fi * FRAME_SAMPLES;
      const chunk = new Float32Array(SILERO_CHUNK);
      for (let i = 0; i < SILERO_CHUNK; i++) {
        const idx = start + i;
        chunk[i] = idx < pcm.length ? pcm[idx] : 0;
      }
      const inputTensor = new ort.Tensor('float32', chunk, [1, SILERO_CHUNK]);
      const stateTensor = new ort.Tensor('float32', this._vadState, [2, 1, 128]);
      const srData = typeof BigInt64Array !== 'undefined'
        ? BigInt64Array.from([BigInt(this.sampleRate)])
        : new Int32Array([this.sampleRate]);
      const srTensor = new ort.Tensor(
        typeof BigInt64Array !== 'undefined' ? 'int64' : 'int32',
        srData,
        [],
      );
      const result = await this.vadSession.run({
        input: inputTensor,
        state: stateTensor,
        sr: srTensor,
      });
      if (result.stateN?.data) {
        this._vadState = new Float32Array(result.stateN.data);
      }
      const outKey = result.output ? 'output' : Object.keys(result)[0];
      probs[fi] = Number(result[outKey]?.data?.[0] ?? 0);
    }
    return probs;
  }

  /** Convert VAD probabilities to contiguous speech regions (sample indices). */
  _vadSpeechRegions(pcm, vadProbs) {
    const minFrames = Math.ceil(MIN_SPEECH_MS / FRAME_MS);
    const regions = [];
    let inSpeech = false;
    let startFrame = 0;
    for (let fi = 0; fi < vadProbs.length; fi++) {
      const speech = vadProbs[fi] >= VAD_THRESHOLD;
      if (speech && !inSpeech) {
        inSpeech = true;
        startFrame = fi;
      } else if (!speech && inSpeech) {
        if (fi - startFrame >= minFrames) {
          regions.push({
            startSample: startFrame * FRAME_SAMPLES,
            endSample: Math.min(fi * FRAME_SAMPLES, pcm.length),
          });
        }
        inSpeech = false;
      }
    }
    if (inSpeech && vadProbs.length - startFrame >= minFrames) {
      regions.push({
        startSample: startFrame * FRAME_SAMPLES,
        endSample: pcm.length,
      });
    }
    return regions;
  }

  /**
   * Run pyannote on one speech region; return frame labels (argmax class per 10 ms).
   * @returns {Promise<{ labels: number[], confidences: number[] }>}
   */
  async _runSegmentation(pcm, start, end) {
    const ort = getOrt();
    const seg = pcm.subarray(start, end);
    const input = new ort.Tensor('float32', seg, [1, 1, seg.length]);
    const feeds = { input_values: input };
    let result;
    try {
      result = await this.segSession.run(feeds);
    } catch {
      result = await this.segSession.run({ input });
    }
    const logitsKey = result.logits ? 'logits' : Object.keys(result)[0];
    const logits = result[logitsKey];
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

  /** Merge consecutive frames with same label into segments (global sample indices). */
  _mergeFrameLabels(labels, confidences, regionStart) {
    const segments = [];
    if (!labels.length) return segments;
    let cur = labels[0];
    let segStart = 0;
    let confSum = confidences[0];
    let confCnt = 1;
    for (let f = 1; f < labels.length; f++) {
      if (labels[f] === cur) {
        confSum += confidences[f];
        confCnt++;
      } else {
        segments.push({
          localLabel: cur,
          startSample: regionStart + segStart * FRAME_SAMPLES,
          endSample: regionStart + f * FRAME_SAMPLES,
          confidence: confSum / confCnt,
        });
        cur = labels[f];
        segStart = f;
        confSum = confidences[f];
        confCnt = 1;
      }
    }
    segments.push({
      localLabel: cur,
      startSample: regionStart + segStart * FRAME_SAMPLES,
      endSample: regionStart + labels.length * FRAME_SAMPLES,
      confidence: confSum / confCnt,
    });
    return segments;
  }

  /** Assign segments shorter than MIN_SEGMENT_MS to nearest temporal neighbor. */
  _mergeShortSegments(segments) {
    const minSamples = Math.floor((MIN_SEGMENT_MS / 1000) * this.sampleRate);
    if (segments.length < 2) return segments.slice();
    const out = segments.map((s) => ({ ...s }));
    for (let i = 0; i < out.length; i++) {
      const dur = out[i].endSample - out[i].startSample;
      if (dur >= minSamples) continue;
      const prev = i > 0 ? out[i - 1] : null;
      const next = i < out.length - 1 ? out[i + 1] : null;
      if (prev && next) {
        const dPrev = out[i].startSample - prev.endSample;
        const dNext = next.startSample - out[i].endSample;
        if (dPrev <= dNext) {
          prev.endSample = out[i].endSample;
          prev.localLabel = out[i].localLabel;
          prev.confidence = (prev.confidence + out[i].confidence) / 2;
        } else {
          next.startSample = out[i].startSample;
          next.localLabel = out[i].localLabel;
          next.confidence = (next.confidence + out[i].confidence) / 2;
        }
      } else if (prev) {
        prev.endSample = out[i].endSample;
        prev.confidence = (prev.confidence + out[i].confidence) / 2;
      } else if (next) {
        next.startSample = out[i].startSample;
        next.confidence = (next.confidence + out[i].confidence) / 2;
      }
      out.splice(i, 1);
      i--;
    }
    return out;
  }

  /**
   * WeSpeaker embedding for one PCM slice.
   * @returns {Promise<Float32Array>}
   */
  async _runEmbedding(pcm, start, end) {
    const ort = getOrt();
    const slice = pcm.subarray(start, end);
    const melFrames = computeLogMelFrames(slice);
    if (!melFrames.length) return new Float32Array(256);
    const nFrames = melFrames.length;
    const flat = new Float32Array(nFrames * MEL_BANDS);
    for (let f = 0; f < nFrames; f++) flat.set(melFrames[f], f * MEL_BANDS);
    const input = new ort.Tensor('float32', flat, [1, nFrames, MEL_BANDS]);
    let result;
    try {
      result = await this.embSession.run({ input });
    } catch {
      result = await this.embSession.run({ feats: input });
    }
    const outKey = result.embedding ? 'embedding' : result.embs ? 'embs' : Object.keys(result)[0];
    const out = result[outKey];
    return new Float32Array(out.data.slice(0, 256));
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

    const pcm = await this._resampleTo16k(audioBuffer);
    const vadProbs = await this._runVAD(pcm);
    const speechRegions = this._vadSpeechRegions(pcm, vadProbs);

    /** @type {Array<{ localLabel: number, startSample: number, endSample: number, confidence: number }>} */
    let rawSegments = [];
    for (const region of speechRegions) {
      const { labels, confidences } = await this._runSegmentation(
        pcm,
        region.startSample,
        region.endSample,
      );
      const merged = this._mergeFrameLabels(labels, confidences, region.startSample);
      rawSegments = rawSegments.concat(merged);
    }

    rawSegments.sort((a, b) => a.startSample - b.startSample);
    rawSegments = this._mergeShortSegments(rawSegments);

    if (!rawSegments.length) {
      return {
        speakers: new Map(),
        segments: [],
        totalSpeakers: 0,
        analysisSampleRate: this.sampleRate,
        totalSamples: pcm.length,
        durationSec: pcm.length / this.sampleRate,
      };
    }

    const embeddings = [];
    for (const seg of rawSegments) {
      const emb = await this._runEmbedding(pcm, seg.startSample, seg.endSample);
      embeddings.push(emb);
    }

    const clusterIds = agglomerativeCluster(embeddings, CLUSTER_THRESHOLD);
    const uniqueClusters = [...new Set(clusterIds)].sort((a, b) => a - b);
    const clusterToGlobal = new Map(uniqueClusters.map((c, i) => [c, `S${i + 1}`]));

    const speakers = new Map();
    uniqueClusters.forEach((c, i) => {
      const id = clusterToGlobal.get(c);
      const mean = new Float32Array(256);
      let cnt = 0;
      clusterIds.forEach((cid, idx) => {
        if (cid !== c) return;
        const e = embeddings[idx];
        for (let d = 0; d < 256; d++) mean[d] += e[d];
        cnt++;
      });
      if (cnt > 0) for (let d = 0; d < 256; d++) mean[d] /= cnt;
      speakers.set(id, {
        id,
        color: SPEAKER_COLORS[i % SPEAKER_COLORS.length],
        embedding: mean,
      });
    });

    const segments = rawSegments.map((seg, i) => ({
      speakerId: clusterToGlobal.get(clusterIds[i]),
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

export default SpeakerDiarizer;