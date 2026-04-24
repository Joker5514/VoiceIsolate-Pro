// Offline DSP processing pipeline using OfflineAudioContext + BiquadFilters, DynamicsCompressor, and advanced spectral subtraction.
// This produces a fully processed AudioBuffer suitable for A/B comparison and export.

import { DSPSettings } from './types';
import { spectralDenoise } from './spectral-denoise';

export interface ProgressEvent {
  percent: number;
  stage: string;
}

export type ProgressCallback = (event: ProgressEvent) => void;

/**
 * Build the DSP graph on a provided AudioContext (offline or realtime) and
 * return the final output node. Caller is responsible for connecting to destination.
 */
export function buildDSPGraph(
  ctx: BaseAudioContext,
  source: AudioNode,
  settings: DSPSettings
): AudioNode {
  let node: AudioNode = source;

  // Stage 1: DC offset / subsonic removal (always on, 20Hz HP)
  const dc = ctx.createBiquadFilter();
  dc.type = 'highpass';
  dc.frequency.value = 20;
  dc.Q.value = 0.707;
  node.connect(dc);
  node = dc;

  // Stage 2: Voice high-pass (remove rumble / AC hum below 80Hz)
  if (settings.highPass) {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = settings.highPassFreq;
    hp.Q.value = 0.9;
    node.connect(hp);
    node = hp;
  }

  // Stage 3: Electrical hum removal (notch filters at 50/60 Hz and harmonics)
  if (settings.humRemoval) {
    const fundamental = settings.humFreq;
    for (let h = 1; h <= 6; h++) {
      const n = ctx.createBiquadFilter();
      n.type = 'notch';
      n.frequency.value = fundamental * h;
      n.Q.value = 30;
      node.connect(n);
      node = n;
    }
  }

  // Optional low-pass (tame hiss)
  if (settings.lowPassEnabled) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = settings.lowPassFreq;
    lp.Q.value = 0.9;
    node.connect(lp);
    node = lp;
  }

  // Stage 4: Noise gate (ratio controlled via DynamicsCompressor)
  const gate = ctx.createDynamicsCompressor();
  // Compressor can be configured as an upward expander proxy by aggressive settings.
  // We use very low threshold + high ratio for gating-like behaviour.
  const gateThresh = settings.gateThreshold + ((100 - settings.spectralGate) / 100) * 10;
  gate.threshold.value = Math.max(-90, Math.min(0, gateThresh));
  gate.ratio.value = Math.max(1, settings.gateRatio);
  gate.attack.value = Math.max(0, settings.gateAttack);
  gate.release.value = Math.max(0.01, settings.gateRelease);
  gate.knee.value = 6;
  node.connect(gate);
  node = gate;

  // Stage 5: 5-band parametric EQ
  const bands: { type: BiquadFilterType; freq: number; q: number; gain: number }[] = [
    { type: 'lowshelf', freq: 120, q: 0.9, gain: settings.eqLow },
    { type: 'peaking', freq: 400, q: 1.1, gain: settings.eqLowMid },
    { type: 'peaking', freq: 1800, q: 1.2, gain: settings.eqMid },
    { type: 'peaking', freq: 5000, q: 1.1, gain: settings.eqHighMid },
    { type: 'highshelf', freq: 12000, q: 0.9, gain: settings.eqHigh },
  ];
  for (const b of bands) {
    const f = ctx.createBiquadFilter();
    f.type = b.type;
    f.frequency.value = b.freq;
    f.Q.value = b.q;
    f.gain.value = b.gain;
    node.connect(f);
    node = f;
  }

  // Stage 6: Voice presence boost (driven by voicePresence slider)
  const warmth = ctx.createBiquadFilter();
  warmth.type = 'peaking';
  warmth.frequency.value = 220;
  warmth.Q.value = 1.0;
  warmth.gain.value = (settings.voicePresence / 100) * 3;
  node.connect(warmth);
  node = warmth;

  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 2000;
  presence.Q.value = 1.3;
  presence.gain.value = (settings.voicePresence / 100) * 8;
  node.connect(presence);
  node = presence;

  // Stage 7: Clarity boost (5-8 kHz intelligibility) + air
  const clar = ctx.createBiquadFilter();
  clar.type = 'peaking';
  clar.frequency.value = 5800;
  clar.Q.value = 1.2;
  clar.gain.value = (settings.clarity / 100) * 7;
  node.connect(clar);
  node = clar;

  const air = ctx.createBiquadFilter();
  air.type = 'highshelf';
  air.frequency.value = 11000;
  air.gain.value = (settings.clarity / 100) * 4;
  node.connect(air);
  node = air;

  // Stage 8: De-esser — notch around 6.5-8 kHz modulated by amount
  if (settings.deEsserEnabled) {
    const deess = ctx.createBiquadFilter();
    deess.type = 'peaking';
    deess.frequency.value = 7200;
    deess.Q.value = 4;
    deess.gain.value = -((settings.deEsser / 100) * 9);
    node.connect(deess);
    node = deess;
  }

  // Stage 9: De-reverb — gentle low-shelf cut + room-mode peaks attenuation
  if (settings.deReverb > 0) {
    const lowCut = ctx.createBiquadFilter();
    lowCut.type = 'lowshelf';
    lowCut.frequency.value = 250;
    lowCut.gain.value = -(settings.deReverb / 100) * 4;
    node.connect(lowCut);
    node = lowCut;

    const mud = ctx.createBiquadFilter();
    mud.type = 'peaking';
    mud.frequency.value = 350;
    mud.Q.value = 1.5;
    mud.gain.value = -(settings.deReverb / 100) * 3;
    node.connect(mud);
    node = mud;
  }

  // Stage 10: Compressor
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = settings.compThreshold - ((settings.compression - 50) / 100) * 12;
  comp.ratio.value = Math.max(1, settings.compRatio);
  comp.attack.value = Math.max(0, settings.compAttack);
  comp.release.value = Math.max(0.01, settings.compRelease);
  comp.knee.value = 8;
  node.connect(comp);
  node = comp;

  // Stage 11: Brick-wall limiter
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.05;
  limiter.knee.value = 0;
  node.connect(limiter);
  node = limiter;

  // Stage 12: Output gain / make-up
  const output = ctx.createGain();
  const makeup = Math.pow(10, settings.outputGain / 20);
  output.gain.value = makeup;
  node.connect(output);

  return output;
}

/**
 * Run the full offline processing pipeline against an input AudioBuffer.
 * Returns a new AudioBuffer with processed audio.
 * When noiseReduction > 0 we additionally run spectral subtraction.
 */
export async function processBuffer(
  input: AudioBuffer,
  settings: DSPSettings,
  onProgress?: ProgressCallback
): Promise<AudioBuffer> {
  const sampleRate = input.sampleRate;

  // Step A: Spectral subtraction noise reduction (if enabled)
  let stageOne: AudioBuffer = input;
  if (settings.noiseReduction > 5) {
    onProgress?.({ percent: 5, stage: 'Profiling noise floor' });
    stageOne = await spectralDenoise(input, settings.noiseReduction / 100, (p) => {
      onProgress?.({ percent: 5 + p * 45, stage: 'Spectral noise reduction' });
    });
  }

  // Step B: Build offline graph and render
  onProgress?.({ percent: 55, stage: 'Applying DSP chain' });
  const off = new OfflineAudioContext(
    stageOne.numberOfChannels,
    stageOne.length,
    sampleRate
  );

  const src = off.createBufferSource();
  src.buffer = stageOne;

  const out = buildDSPGraph(off, src, settings);
  out.connect(off.destination);
  src.start(0);

  const rendered = await off.startRendering();
  onProgress?.({ percent: 90, stage: 'Finalising' });

  // Step C: Optional peak normalisation
  let final = rendered;
  if (settings.normalize) {
    final = normalizePeaks(rendered, 0.97);
  }

  onProgress?.({ percent: 100, stage: 'Done' });
  return final;
}

/** Peak-normalise an AudioBuffer to target (0..1). Returns a fresh buffer. */
export function normalizePeaks(buf: AudioBuffer, target: number): AudioBuffer {
  const ctx = new OfflineAudioContext(buf.numberOfChannels, 1, buf.sampleRate);
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const data = buf.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i] ?? 0);
      if (a > peak) peak = a;
    }
  }
  const gain = peak > 0 ? target / peak : 1;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < src.length; i++) {
      dst[i] = (src[i] ?? 0) * gain;
    }
  }
  return out;
}
