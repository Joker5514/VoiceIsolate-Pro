/**
 * VoiceIsolate Pro — Full Audio Analysis Orchestrator (Layer 1: Core)
 *
 * Runs classical feature extraction, segmentation, whisper logic, and
 * recommendation. ML soft scores can be injected via opts.mlHints.
 * Pure module (no workers / DOM).
 */
'use strict';

import {
  extractFrameFeatures,
  downmixToMono,
  globalLevels,
} from './FeatureExtractor.js';
import {
  framesToSegments,
  majoritySmooth,
  labelFrames,
  continuityScore,
} from './SegmentMerger.js';
import { detectWhisperRegions } from './WhisperLogic.js';
import { recommendFromAnalysis } from './RecommendationEngine.js';

/**
 * Classify each frame into a primary activity label.
 * @param {object} frame
 * @param {object} ctx
 */
function classifyFrame(frame, ctx) {
  const noiseFloor = ctx.noiseFloor || 0.001;
  if (frame.rms < noiseFloor * 1.5 || frame.rmsDb < -55) return 'silence';
  if (frame.flux > ctx.fluxThresh && frame.flatness > 0.4) return 'transient';
  if (frame.humStrength > 0.2 && frame.speechRatio < 0.2) return 'hum';
  // Music: harmonic, lower speech band ratio, mid flatness
  if (frame.harmonicity > 0.25 && frame.speechRatio < 0.28 && frame.flatness < 0.45 && frame.rmsDb > -40) {
    return 'music';
  }
  // Broadband noise: high flatness, low harmonicity
  if (frame.flatness > 0.55 && frame.harmonicity < 0.12 && frame.speechRatio < 0.25) {
    return 'noise';
  }
  // Reverb-ish: lower flux continuity, mid energy after speech
  if (ctx.reverbEstimate > 0.4 && frame.speechRatio < 0.2 && frame.rmsDb > -48 && frame.flatness > 0.35) {
    return 'reverb';
  }
  if (frame.speechRatio > 0.22 || frame.voiced > 0.35 || frame.harmonicity > 0.15) {
    return 'speech';
  }
  return 'noise';
}

/**
 * Run full analysis on channel data.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {object} [opts]
 */
export function analyzeAudio(channels, sampleRate, opts = {}) {
  const mono = downmixToMono(channels);
  const levels = globalLevels(mono);
  const extraction = extractFrameFeatures(mono, sampleRate, {
    frameSec: opts.frameSec,
    hopSec: opts.hopSec,
  });
  const frames = extraction.frames;
  const hopSec = extraction.hopSec;

  const fluxVals = frames.map((f) => f.flux).sort((a, b) => a - b);
  const fluxThresh = fluxVals[Math.floor(fluxVals.length * 0.85)] || 0.02;

  const ctx = {
    noiseFloor: extraction.noiseFloor,
    reverbEstimate: extraction.reverbEstimate,
    fluxThresh,
  };

  const labels = frames.map((f) => classifyFrame(f, ctx));
  // Optional ML VAD soft override
  if (opts.mlHints && Array.isArray(opts.mlHints.vadActive)) {
    for (let i = 0; i < labels.length && i < opts.mlHints.vadActive.length; i++) {
      if (opts.mlHints.vadActive[i] && labels[i] === 'noise') labels[i] = 'speech';
      if (opts.mlHints.vadActive[i] === false && labels[i] === 'speech' && frames[i].rmsDb < -40) {
        // keep classical if uncertain
      }
    }
  }

  const smoothed = majoritySmooth(labels.map((l) => l === 'speech'), 2);
  for (let i = 0; i < labels.length; i++) {
    if (smoothed[i] && labels[i] === 'noise') labels[i] = 'speech';
  }

  const byLabel = (name) => framesToSegments(
    labelFrames(frames, (_, i) => (labels[i] === name ? name : 'other'), (f) => {
      if (name === 'speech') return Math.min(1, (f.speechRatio || 0) + (f.voiced || 0) * 0.5);
      if (name === 'music') return Math.min(1, (f.harmonicity || 0));
      if (name === 'noise') return Math.min(1, f.flatness || 0);
      if (name === 'silence') return f.rmsDb < -50 ? 0.9 : 0.5;
      if (name === 'hum') return f.humStrength || 0;
      if (name === 'transient') return Math.min(1, (f.flux || 0) * 20);
      if (name === 'reverb') return Math.min(1, ctx.reverbEstimate);
      return 0.5;
    }).filter((x) => x.label === name),
    hopSec,
    { minSec: name === 'transient' ? 0.04 : 0.12, mergeGapSec: name === 'transient' ? 0.05 : 0.18 },
  );

  const speechSegments = byLabel('speech');
  const silenceSegments = byLabel('silence');
  const musicSegments = byLabel('music');
  const noiseSegments = byLabel('noise');
  const transientSegments = byLabel('transient');
  const reverbSegments = byLabel('reverb');
  const humSegments = byLabel('hum');

  const whisperPack = detectWhisperRegions(extraction, opts.whisper);

  // Speaker segments: crude energy-based primary/secondary split if ML not provided
  let speakerSegments = opts.mlHints?.speakerSegments || [];
  let overlapRegions = opts.mlHints?.overlapRegions || [];
  if (!speakerSegments.length && speechSegments.length) {
    // Single lead speaker covering speech regions
    speakerSegments = speechSegments.map((s, i) => ({
      speakerId: 'S1',
      label: 'Lead speech',
      start: s.start,
      end: s.end,
      confidence: s.confidence * 0.7,
    }));
  }

  const speechRatio = labels.filter((l) => l === 'speech').length / (labels.length || 1);
  const musicRatio = labels.filter((l) => l === 'music').length / (labels.length || 1);
  const bandwidthLimited = frames.length
    ? frames.reduce((a, f) => a + f.rolloff, 0) / frames.length < 4500
    : false;

  const confidenceScores = {
    speechRatio,
    musicRatio,
    snrDb: extraction.snrDb,
    continuity: continuityScore(labels),
    hum: extraction.humProfile.strength,
    reverb: extraction.reverbEstimate,
    analysisQuality: opts.mlHints ? 0.75 : 0.55,
    bandwidthLimited,
    classicalOnly: !opts.mlHints,
  };

  const detectedSources = [];
  if (speechSegments.length) detectedSources.push({ id: 'lead_speech', label: 'Lead speech', confidence: Math.min(1, speechRatio + 0.2) });
  if (speakerSegments.some((s) => s.speakerId && s.speakerId !== 'S1')) {
    detectedSources.push({ id: 'secondary_speech', label: 'Secondary speech', confidence: 0.5 });
  }
  if (musicSegments.length) detectedSources.push({ id: 'music', label: 'Music bed', confidence: Math.min(1, musicRatio + 0.3) });
  if (noiseSegments.length) detectedSources.push({ id: 'noise', label: 'Broadband noise', confidence: 0.55 });
  if (extraction.humProfile.present) detectedSources.push({ id: 'hum', label: 'Hum/buzz', confidence: extraction.humProfile.strength });
  if (transientSegments.length) detectedSources.push({ id: 'transients', label: 'Transients', confidence: 0.5 });
  if (reverbSegments.length || extraction.reverbEstimate > 0.3) {
    detectedSources.push({ id: 'ambience', label: 'Ambience / reverb', confidence: extraction.reverbEstimate });
  }
  if (whisperPack.whisperRegions.length) {
    detectedSources.push({ id: 'whisper', label: 'Whisper / faint speech', confidence: 0.6 });
  }

  const visualLayers = buildVisualLayers({
    speechSegments,
    silenceSegments,
    musicSegments,
    noiseSegments,
    transientSegments,
    reverbSegments,
    humSegments,
    speakerSegments,
    whisperRegions: whisperPack.whisperRegions,
    difficultSpeechRegions: whisperPack.difficultSpeechRegions,
    overlapRegions,
  });

  const duration = mono.length / sampleRate;
  const analysis = {
    duration,
    sampleRate,
    channels: channels.length,
    rms: levels.rms,
    peak: levels.peak,
    loudnessEstimate: levels.rmsDb,
    snrDb: extraction.snrDb,
    globalNoiseProfile: {
      floor: extraction.noiseFloor,
      floorDb: 20 * Math.log10(extraction.noiseFloor + 1e-12),
    },
    humProfile: extraction.humProfile,
    roomEstimate: extraction.reverbEstimate,
    reverbEstimate: extraction.reverbEstimate,
    speechSegments,
    silenceSegments,
    musicSegments,
    noiseSegments,
    transientSegments,
    reverbSegments,
    humSegments,
    speakerSegments,
    overlapRegions,
    whisperRegions: whisperPack.whisperRegions,
    difficultSpeechRegions: whisperPack.difficultSpeechRegions,
    detectedSources,
    confidenceScores,
    visualLayers,
    frameCount: frames.length,
    platformHints: opts.platformHints || {},
  };

  const rec = recommendFromAnalysis(analysis);
  analysis.recommendedPreset = rec.recommendedPreset;
  analysis.recommendedStageConfig = rec.recommendedStageConfig;
  analysis.recommendedProcessingPlan = rec.recommendedProcessingPlan;
  analysis.recommendation = rec;

  return analysis;
}

function buildVisualLayers(parts) {
  const color = {
    lead_speech: '#3b82f6',
    secondary_speech: '#8b5cf6',
    music: '#ec4899',
    noise: '#6b7280',
    hum: '#f59e0b',
    transients: '#ef4444',
    ambience: '#14b8a6',
    silence: '#1f2937',
    whisper: '#a3e635',
    difficult: '#fbbf24',
    overlap: '#f472b6',
    recommend: '#38bdf8',
  };

  const layer = (id, label, segments, conf = 0.5) => ({
    id,
    label,
    color: color[id] || '#94a3b8',
    confidence: conf,
    segments: (segments || []).map((s) => ({
      start: s.start,
      end: s.end,
      confidence: s.confidence ?? conf,
      meta: s.label || s.speakerId || id,
    })),
  });

  const lead = (parts.speakerSegments || []).filter((s) => !s.speakerId || s.speakerId === 'S1');
  const secondary = (parts.speakerSegments || []).filter((s) => s.speakerId && s.speakerId !== 'S1');

  return [
    layer('lead_speech', 'Lead speech', lead.length ? lead : parts.speechSegments, 0.7),
    layer('secondary_speech', 'Secondary speech', secondary, 0.45),
    layer('music', 'Music bed', parts.musicSegments, 0.5),
    layer('noise', 'Broadband noise', parts.noiseSegments, 0.5),
    layer('hum', 'Hum', parts.humSegments, 0.5),
    layer('transients', 'Transients', parts.transientSegments, 0.45),
    layer('ambience', 'Ambience / reverb', parts.reverbSegments, 0.4),
    layer('silence', 'Silence', parts.silenceSegments, 0.8),
    layer('whisper', 'Whisper / faint speech', parts.whisperRegions, 0.55),
    layer('difficult', 'Difficult speech', parts.difficultSpeechRegions, 0.5),
    layer('overlap', 'Overlap', parts.overlapRegions, 0.4),
  ];
}

export default { analyzeAudio };
