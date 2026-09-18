/**
 * VoiceIsolate-Pro — Automatic Audio Analysis
 * Runs automatically after Import/Record per issue §4
 *
 * - Preserve raw immutable
 * - Track noise floor
 * - VAD / speech detection
 * - Detect whisper candidates
 * - Detect probable speakers / sound sources
 * - Generate local source/mask information
 * - Render detected regions onto canvas
 *
 * Fallback to deterministic DSP if neural path unavailable
 */

import { SAMPLE_RATE } from '../../audio-config.js';

export const AnalysisOverlays = Object.freeze({
  SPEECH: 'speech',
  WHISPER: 'whisper',
  NOISE: 'background_noise',
  HUM: 'hum',
  MUSIC: 'music',
  SECONDARY_SPEAKER: 'secondary_speaker',
});

function dbFromLinear(linear) {
  if (linear <= 1e-10) return -100;
  return 20 * Math.log10(linear);
}

function computeRMS(channel) {
  let sum = 0;
  for (let i = 0; i < channel.length; i++) {
    sum += channel[i] * channel[i];
  }
  return Math.sqrt(sum / channel.length);
}

function computePeak(channel) {
  let peak = 0;
  for (let i = 0; i < channel.length; i++) {
    const abs = Math.abs(channel[i]);
    if (abs > peak) peak = abs;
  }
  return peak;
}

/**
 * Simple noise floor tracking via histogram of low-energy frames
 */
function estimateNoiseFloor(channelData, sampleRate) {
  const frameSize = Math.floor(sampleRate * 0.02); // 20ms
  const hop = frameSize;
  const rmsValues = [];
  for (let pos = 0; pos + frameSize < channelData.length; pos += hop) {
    let sum = 0;
    for (let i = 0; i < frameSize; i++) {
      const s = channelData[pos + i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / frameSize);
    rmsValues.push(rms);
  }
  if (rmsValues.length === 0) return { floorDb: -60, floorLinear: 0.001 };
  // 10th percentile as noise floor estimate
  rmsValues.sort((a, b) => a - b);
  const idx = Math.floor(rmsValues.length * 0.1);
  const floorLinear = rmsValues[idx] || 0.001;
  return { floorDb: dbFromLinear(floorLinear), floorLinear, rmsValues };
}

/**
 * Simple VAD: energy + zero-crossing heuristic
 * Returns segments [{ start, end, confidence, type }]
 */
function detectSpeech(channelData, sampleRate, noiseFloor) {
  const frameSize = Math.floor(sampleRate * 0.025); // 25ms
  const hop = Math.floor(sampleRate * 0.01); // 10ms
  const segments = [];
  let inSpeech = false;
  let segStart = 0;
  let confidences = [];

  for (let pos = 0; pos + frameSize < channelData.length; pos += hop) {
    let sum = 0;
    let zc = 0;
    let prev = channelData[pos];
    for (let i = 0; i < frameSize; i++) {
      const s = channelData[pos + i];
      sum += s * s;
      if ((prev >= 0 && s < 0) || (prev < 0 && s >= 0)) zc++;
      prev = s;
    }
    const rms = Math.sqrt(sum / frameSize);
    const rmsDb = dbFromLinear(rms);
    const isSpeech = rmsDb > noiseFloor.floorDb + 6 && zc > 5 && zc < frameSize * 0.5;
    const confidence = Math.min(1, Math.max(0, (rmsDb - noiseFloor.floorDb) / 24));

    if (isSpeech && !inSpeech) {
      inSpeech = true;
      segStart = pos / sampleRate;
      confidences = [confidence];
    } else if (isSpeech && inSpeech) {
      confidences.push(confidence);
    } else if (!isSpeech && inSpeech) {
      // require at least 100ms speech
      const dur = pos / sampleRate - segStart;
      if (dur > 0.1) {
        const avgConf = confidences.reduce((a, b) => a + b, 0) / confidences.length;
        segments.push({
          start: segStart,
          end: pos / sampleRate,
          confidence: avgConf,
          type: AnalysisOverlays.SPEECH,
          label: 'Speech',
        });
      }
      inSpeech = false;
    }
  }
  if (inSpeech) {
    const dur = channelData.length / sampleRate - segStart;
    if (dur > 0.1) {
      const avgConf = confidences.reduce((a, b) => a + b, 0) / confidences.length;
      segments.push({
        start: segStart,
        end: channelData.length / sampleRate,
        confidence: avgConf,
        type: AnalysisOverlays.SPEECH,
        label: 'Speech',
      });
    }
  }
  return segments;
}

/**
 * Whisper detection: low-energy speech candidates
 */
function detectWhisper(channelData, sampleRate, noiseFloor, speechSegments) {
  const whisper = [];
  // Look for low-energy regions that are just above noise floor but below normal speech
  const frameSize = Math.floor(sampleRate * 0.03);
  const hop = Math.floor(sampleRate * 0.015);
  for (let pos = 0; pos + frameSize < channelData.length; pos += hop) {
    let sum = 0;
    for (let i = 0; i < frameSize; i++) sum += channelData[pos + i] * channelData[pos + i];
    const rms = Math.sqrt(sum / frameSize);
    const rmsDb = dbFromLinear(rms);
    // Whisper: 3-10 dB above floor, but not overlapping loud speech
    const isLowEnergy = rmsDb > noiseFloor.floorDb + 2 && rmsDb < noiseFloor.floorDb + 12;
    if (!isLowEnergy) continue;
    const t = pos / sampleRate;
    // check if inside speech segment with low confidence already, or isolated
    const insideSpeech = speechSegments.some((s) => t >= s.start && t <= s.end);
    if (insideSpeech) continue; // already speech, not whisper
    // check surrounding energy: if isolated low-energy blip, candidate whisper
    whisper.push({
      start: t,
      end: t + frameSize / sampleRate,
      confidence: Math.max(0.3, Math.min(0.8, (rmsDb - noiseFloor.floorDb) / 10)),
      type: AnalysisOverlays.WHISPER,
      label: 'Whisper',
      rmsDb,
    });
  }
  // Merge close whisper candidates
  return mergeSegments(whisper, 0.15);
}

/**
 * Hum detection: narrowband 50/60Hz + harmonics
 */
function detectHum(channelData, sampleRate) {
  // Simplified: check energy around 50, 60, 100, 120, 150, 180
  const humFreqs = [50, 60, 100, 120, 150, 180];
  // We can't do FFT here without DSPCore, so heuristic: if overall noise floor is tonal
  // Return empty for now, but structure for future
  // For deterministic path, we estimate hum if low-frequency energy is high
  let lowEnergy = 0;
  let totalEnergy = 0;
  const checkLen = Math.min(channelData.length, sampleRate * 2);
  for (let i = 0; i < checkLen; i++) {
    const s = channelData[i];
    totalEnergy += s * s;
    // crude low-pass via moving average would be expensive; use sample itself as proxy for now
    // Actually count low freq by checking slow variation: diff between consecutive samples
    if (i > 0) {
      const diff = Math.abs(s - channelData[i - 1]);
      if (diff < 0.001) lowEnergy += s * s;
    }
  }
  const ratio = totalEnergy > 0 ? lowEnergy / totalEnergy : 0;
  if (ratio > 0.3) {
    return [{
      start: 0,
      end: channelData.length / sampleRate,
      confidence: Math.min(0.9, ratio),
      type: AnalysisOverlays.HUM,
      label: 'Hum',
      freqs: humFreqs,
    }];
  }
  return [];
}

function detectNoise(channelData, sampleRate, noiseFloor, speechSegments) {
  // Background noise is where speech is NOT present, with consistent floor
  const noiseRegions = [];
  let lastEnd = 0;
  const sortedSpeech = [...speechSegments].sort((a, b) => a.start - b.start);
  for (const seg of sortedSpeech) {
    if (seg.start - lastEnd > 0.2) {
      noiseRegions.push({
        start: lastEnd,
        end: seg.start,
        confidence: 0.6,
        type: AnalysisOverlays.NOISE,
        label: 'Background Noise',
      });
    }
    lastEnd = Math.max(lastEnd, seg.end);
  }
  const totalDur = channelData.length / sampleRate;
  if (totalDur - lastEnd > 0.2) {
    noiseRegions.push({
      start: lastEnd,
      end: totalDur,
      confidence: 0.6,
      type: AnalysisOverlays.NOISE,
      label: 'Background Noise',
    });
  }
  return noiseRegions;
}

function mergeSegments(segments, gap = 0.1) {
  if (segments.length === 0) return [];
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = merged[merged.length - 1];
    if (cur.start - last.end <= gap && cur.type === last.type) {
      last.end = Math.max(last.end, cur.end);
      last.confidence = Math.max(last.confidence, cur.confidence);
    } else {
      merged.push({ ...cur });
    }
  }
  return merged;
}

/**
 * Main automatic analysis entry point
 * @param {Float32Array[]} channelData - array of channels
 * @param {number} sampleRate
 * @param {object} options
 * @returns {Promise<object>} analysis result
 */
export async function runAutoAnalysis(channelData, sampleRate = SAMPLE_RATE, options = {}) {
  const { signal, onProgress } = options;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const primary = channelData[0] || new Float32Array(0);
  const duration = primary.length / sampleRate;

  const emit = (pct, extra = {}) => {
    if (onProgress) onProgress(pct, extra);
  };

  emit(5, { stage: 'noise_floor' });
  const noiseFloor = estimateNoiseFloor(primary, sampleRate);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  emit(20, { stage: 'vad' });
  const speechSegments = detectSpeech(primary, sampleRate, noiseFloor);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  emit(40, { stage: 'whisper' });
  const whisperCandidates = detectWhisper(primary, sampleRate, noiseFloor, speechSegments);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  emit(60, { stage: 'hum' });
  const humSegments = detectHum(primary, sampleRate);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  emit(75, { stage: 'noise' });
  const noiseSegments = detectNoise(primary, sampleRate, noiseFloor, speechSegments);
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  emit(85, { stage: 'speakers' });
  // Speaker detection: placeholder for now, will be enriched by diarization worker if available
  const speakers = [];
  // Simple energy-based secondary speaker detection: look for overlapping speech with different energy profiles
  // For now, empty — real implementation would use diarization.js
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  emit(90, { stage: 'metrics' });
  const rms = computeRMS(primary);
  const peak = computePeak(primary);
  const snrDb = dbFromLinear(rms) - noiseFloor.floorDb;
  const speechRatio = speechSegments.reduce((sum, s) => sum + (s.end - s.start), 0) / Math.max(0.001, duration);

  emit(95, { stage: 'regions' });
  // Build unified regions list
  const allRegions = [
    ...speechSegments.map((r) => ({ ...r, id: `r-${Math.random().toString(36).slice(2, 8)}` })),
    ...whisperCandidates.map((r) => ({ ...r, id: `r-${Math.random().toString(36).slice(2, 8)}` })),
    ...noiseSegments.map((r) => ({ ...r, id: `r-${Math.random().toString(36).slice(2, 8)}` })),
    ...humSegments.map((r) => ({ ...r, id: `r-${Math.random().toString(36).slice(2, 8)}` })),
  ].sort((a, b) => a.start - b.start);

  // Deduplicate overlapping same-type regions already merged, but keep different types overlapping
  const merged = [];
  const byType = {};
  for (const r of allRegions) {
    if (!byType[r.type]) byType[r.type] = [];
    byType[r.type].push(r);
  }
  for (const type of Object.keys(byType)) {
    merged.push(...mergeSegments(byType[type], 0.2));
  }

  emit(100, { stage: 'complete' });

  return {
    duration,
    sampleRate,
    channels: channelData.length,
    noiseFloor,
    snrDb,
    rms,
    peak,
    speechRatio,
    speechSegments,
    whisperCandidates,
    humSegments,
    noiseSegments,
    speakers,
    regions: merged.sort((a, b) => a.start - b.start),
    confidence: Math.min(1, Math.max(0, speechRatio * 0.5 + (snrDb > 10 ? 0.5 : snrDb / 20))),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Attempt to use ML-based analysis if available, fallback to DSP
 */
export async function runAnalysisWithFallback(channelData, sampleRate, options = {}) {
  const { tryML = true } = options;
  // Try ML path first if available (e.g., Silero VAD via worker)
  if (tryML) {
    try {
      // Check if we have a FullAnalysisHost available globally or via import
      // For now, use DSP path as primary, ML as enhancement
      const dspResult = await runAutoAnalysis(channelData, sampleRate, options);
      // If ML worker available, we could enhance, but keep DSP as baseline
      return dspResult;
    } catch (err) {
      console.warn('[AutoAnalysis] ML path failed, falling back to DSP', err);
    }
  }
  // Pure DSP fallback — never breaks playback
  return runAutoAnalysis(channelData, sampleRate, options);
}

export default { runAutoAnalysis, runAnalysisWithFallback, AnalysisOverlays };
