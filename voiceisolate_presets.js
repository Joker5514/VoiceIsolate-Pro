// voiceisolate_presets.js
// Ported from voiceisolate_presets.ts — no TypeScript build step required.
// Canonical preset definitions for VoiceIsolate Pro 32-stage DSP pipeline.

export const PRESET_VERSION = '8.0.0';

export const PRESETS = [
  {
    id: 'clean-voice',
    label: 'Clean Voice',
    description: 'Optimized for speech clarity in quiet environments',
    params: {
      gateThresh: 0.12,
      gateRange: 0.95,
      gateAttack: 0.003,
      gateRelease: 0.08,
      gateHold: 0.02,
      outGain: 1.0,
      dryWet: 1.0,
      harmonicEnhance: 0.1,
      noiseReduce: 0.6,
      humReduce: 0.4,
      dereverb: 0.25,
      voiceFocus: 0.85,
      wienerAmount: 0.5,
      spectralFloor: 0.02,
      barkGateBias: 0.0,
      phaseMix: 1.0
    }
  },
  {
    id: 'noisy-environment',
    label: 'Noisy Environment',
    description: 'Heavy noise suppression for crowded or outdoor recordings',
    params: {
      gateThresh: 0.22,
      gateRange: 0.98,
      gateAttack: 0.005,
      gateRelease: 0.12,
      gateHold: 0.03,
      outGain: 1.1,
      dryWet: 0.95,
      harmonicEnhance: 0.2,
      noiseReduce: 0.9,
      humReduce: 0.7,
      dereverb: 0.5,
      voiceFocus: 0.9,
      wienerAmount: 0.75,
      spectralFloor: 0.05,
      barkGateBias: 0.1,
      phaseMix: 0.9
    }
  },
  {
    id: 'podcast',
    label: 'Podcast / Broadcast',
    description: 'Balanced processing for broadcast-quality voice',
    params: {
      gateThresh: 0.15,
      gateRange: 0.92,
      gateAttack: 0.004,
      gateRelease: 0.09,
      gateHold: 0.025,
      outGain: 1.05,
      dryWet: 0.88,
      harmonicEnhance: 0.18,
      noiseReduce: 0.65,
      humReduce: 0.5,
      dereverb: 0.3,
      voiceFocus: 0.82,
      wienerAmount: 0.55,
      spectralFloor: 0.025,
      barkGateBias: 0.05,
      phaseMix: 1.0
    }
  },
  {
    id: 'forensic',
    label: 'Forensic / Maximum Isolation',
    description: 'Aggressive isolation for audio evidence and transcription',
    params: {
      gateThresh: 0.28,
      gateRange: 0.99,
      gateAttack: 0.002,
      gateRelease: 0.15,
      gateHold: 0.04,
      outGain: 1.2,
      dryWet: 1.0,
      harmonicEnhance: 0.05,
      noiseReduce: 0.98,
      humReduce: 0.95,
      dereverb: 0.8,
      voiceFocus: 0.98,
      wienerAmount: 0.92,
      spectralFloor: 0.08,
      barkGateBias: 0.15,
      phaseMix: 0.8
    }
  },
  {
    id: 'music-stem',
    label: 'Music Vocal Stem',
    description: 'Tuned for isolating vocals from music productions',
    params: {
      gateThresh: 0.08,
      gateRange: 0.85,
      gateAttack: 0.006,
      gateRelease: 0.06,
      gateHold: 0.015,
      outGain: 0.95,
      dryWet: 0.75,
      harmonicEnhance: 0.3,
      noiseReduce: 0.4,
      humReduce: 0.3,
      dereverb: 0.15,
      voiceFocus: 0.7,
      wienerAmount: 0.35,
      spectralFloor: 0.01,
      barkGateBias: -0.05,
      phaseMix: 1.0
    }
  },
  {
    id: 'passthrough',
    label: 'Bypass / Passthrough',
    description: 'Zero processing — direct audio passthrough for A/B comparison',
    params: {
      gateThresh: 0.0,
      gateRange: 0.0,
      gateAttack: 0.0,
      gateRelease: 0.0,
      gateHold: 0.0,
      outGain: 1.0,
      dryWet: 0.0,
      harmonicEnhance: 0.0,
      noiseReduce: 0.0,
      humReduce: 0.0,
      dereverb: 0.0,
      voiceFocus: 0.0,
      wienerAmount: 0.0,
      spectralFloor: 0.0,
      barkGateBias: 0.0,
      phaseMix: 1.0
    }
  }
];

/**
 * Get a preset by ID.
 * @param {string} id
 * @returns {object|undefined}
 */
export function getPreset(id) {
  return PRESETS.find(p => p.id === id);
}

/**
 * Apply a preset's params to the worklet and worker via the App controller.
 * @param {string} id - preset ID
 * @param {Function} setParam - (key, value, target) dispatcher
 */
export function applyPreset(id, setParam) {
  const preset = getPreset(id);
  if (!preset) {
    console.warn(`[presets] Unknown preset id: ${id}`);
    return;
  }
  for (const [key, value] of Object.entries(preset.params)) {
    setParam(key, value, 'both');
  }
}
