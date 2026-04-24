// DSP Types and Settings

export interface DSPSettings {
  // Noise reduction intensity (0-100)
  noiseReduction: number;
  // Voice presence / warmth (0-100)
  voicePresence: number;
  // Clarity / air (0-100)
  clarity: number;
  // Spectral gate threshold (0-100)
  spectralGate: number;
  // De-reverb (0-100)
  deReverb: number;
  // De-esser amount (0-100)
  deEsser: number;
  // Compression amount (0-100)
  compression: number;

  // Toggles
  humRemoval: boolean;
  humFreq: 50 | 60;
  highPass: boolean;
  normalize: boolean;
  deEsserEnabled: boolean;
  pitchCorrection: boolean;

  // Advanced EQ bands (peaking)
  eqLow: number; // gain in dB, freq 200
  eqLowMid: number; // gain in dB, freq 800
  eqMid: number; // gain in dB, freq 2500
  eqHighMid: number; // gain in dB, freq 5500
  eqHigh: number; // gain in dB, freq 12000

  // Compressor details
  compThreshold: number; // dB (-60 to 0)
  compRatio: number; // 1-20
  compAttack: number; // sec 0-1
  compRelease: number; // sec 0-1

  // Noise gate
  gateThreshold: number; // dB (-80 to 0)
  gateRatio: number; // 1-20
  gateAttack: number; // sec
  gateRelease: number; // sec

  // Filters
  highPassFreq: number; // Hz (20-500)
  lowPassEnabled: boolean;
  lowPassFreq: number; // Hz (500-20000)

  // Output
  outputGain: number; // dB (-12 to 12)
}

export const defaultSettings: DSPSettings = {
  noiseReduction: 65,
  voicePresence: 55,
  clarity: 60,
  spectralGate: 45,
  deReverb: 50,
  deEsser: 40,
  compression: 50,

  humRemoval: true,
  humFreq: 60,
  highPass: true,
  normalize: true,
  deEsserEnabled: true,
  pitchCorrection: false,

  eqLow: 0,
  eqLowMid: 0,
  eqMid: 2,
  eqHighMid: 3,
  eqHigh: 2,

  compThreshold: -24,
  compRatio: 4,
  compAttack: 0.003,
  compRelease: 0.25,

  gateThreshold: -55,
  gateRatio: 12,
  gateAttack: 0.002,
  gateRelease: 0.1,

  highPassFreq: 80,
  lowPassEnabled: false,
  lowPassFreq: 16000,

  outputGain: 0,
};

export type PresetName =
  | 'podcast'
  | 'musicVocal'
  | 'interview'
  | 'voiceover'
  | 'audiobook'
  | 'broadcast'
  | 'zoomCall'
  | 'streaming'
  | 'asmr'
  | 'neutral';

export interface PresetDef {
  id: PresetName;
  label: string;
  description: string;
  icon: string; // lucide icon name
  settings: Partial<DSPSettings>;
}

export const PRESETS: PresetDef[] = [
  {
    id: 'podcast',
    label: 'Podcast',
    description: 'Warm, full voice with smooth dynamics',
    icon: 'Mic',
    settings: {
      noiseReduction: 65,
      voicePresence: 70,
      clarity: 55,
      spectralGate: 40,
      deReverb: 45,
      deEsser: 50,
      compression: 65,
      humRemoval: true,
      highPass: true,
      normalize: true,
      deEsserEnabled: true,
      eqLow: 2,
      eqLowMid: 1,
      eqMid: 3,
      eqHighMid: 2,
      eqHigh: 1,
      compThreshold: -22,
      compRatio: 4,
      gateThreshold: -55,
      highPassFreq: 80,
    },
  },
  {
    id: 'musicVocal',
    label: 'Music Vocal',
    description: 'Isolate lead vocals from backing track',
    icon: 'Music2',
    settings: {
      noiseReduction: 30,
      voicePresence: 85,
      clarity: 80,
      spectralGate: 25,
      deReverb: 20,
      deEsser: 35,
      compression: 35,
      humRemoval: false,
      highPass: true,
      normalize: true,
      deEsserEnabled: true,
      eqLow: -3,
      eqLowMid: -2,
      eqMid: 4,
      eqHighMid: 5,
      eqHigh: 3,
      compThreshold: -18,
      compRatio: 3,
      gateThreshold: -45,
      highPassFreq: 120,
      lowPassEnabled: false,
    },
  },
  {
    id: 'interview',
    label: 'Interview',
    description: 'Multi-speaker clarity with noise removal',
    icon: 'Users',
    settings: {
      noiseReduction: 75,
      voicePresence: 60,
      clarity: 65,
      spectralGate: 55,
      deReverb: 60,
      deEsser: 45,
      compression: 55,
      humRemoval: true,
      highPass: true,
      normalize: true,
      eqLow: 1,
      eqMid: 3,
      eqHighMid: 3,
      eqHigh: 1,
      gateThreshold: -50,
      highPassFreq: 100,
    },
  },
  {
    id: 'voiceover',
    label: 'Voice-Over',
    description: 'Broadcast-ready narration',
    icon: 'Radio',
    settings: {
      noiseReduction: 70,
      voicePresence: 80,
      clarity: 75,
      spectralGate: 50,
      deReverb: 70,
      deEsser: 60,
      compression: 75,
      humRemoval: true,
      highPass: true,
      normalize: true,
      deEsserEnabled: true,
      eqLow: 3,
      eqLowMid: 0,
      eqMid: 2,
      eqHighMid: 4,
      eqHigh: 3,
      compThreshold: -20,
      compRatio: 5,
      gateThreshold: -52,
    },
  },
  {
    id: 'audiobook',
    label: 'Audiobook',
    description: 'Warm, intimate spoken-word',
    icon: 'BookOpen',
    settings: {
      noiseReduction: 70,
      voicePresence: 65,
      clarity: 50,
      spectralGate: 50,
      deReverb: 65,
      deEsser: 55,
      compression: 60,
      humRemoval: true,
      highPass: true,
      normalize: true,
      deEsserEnabled: true,
      eqLow: 3,
      eqLowMid: 2,
      eqMid: 2,
      eqHighMid: 1,
      eqHigh: 0,
      gateThreshold: -55,
    },
  },
  {
    id: 'broadcast',
    label: 'Broadcast',
    description: 'FM-radio style thick, present voice',
    icon: 'Antenna',
    settings: {
      noiseReduction: 60,
      voicePresence: 85,
      clarity: 70,
      spectralGate: 45,
      deReverb: 55,
      deEsser: 65,
      compression: 85,
      humRemoval: true,
      highPass: true,
      normalize: true,
      deEsserEnabled: true,
      eqLow: 4,
      eqLowMid: 2,
      eqMid: 3,
      eqHighMid: 4,
      eqHigh: 3,
      compThreshold: -18,
      compRatio: 8,
      gateThreshold: -50,
    },
  },
  {
    id: 'zoomCall',
    label: 'Zoom/Call',
    description: 'Clean up noisy video-call audio',
    icon: 'Video',
    settings: {
      noiseReduction: 90,
      voicePresence: 55,
      clarity: 70,
      spectralGate: 70,
      deReverb: 75,
      deEsser: 40,
      compression: 55,
      humRemoval: true,
      highPass: true,
      normalize: true,
      deEsserEnabled: true,
      eqLow: 0,
      eqMid: 4,
      eqHighMid: 3,
      eqHigh: 2,
      gateThreshold: -45,
      highPassFreq: 120,
    },
  },
  {
    id: 'streaming',
    label: 'Streaming',
    description: 'Twitch / YouTube live voice',
    icon: 'Tv',
    settings: {
      noiseReduction: 70,
      voicePresence: 75,
      clarity: 75,
      spectralGate: 55,
      deReverb: 60,
      deEsser: 55,
      compression: 70,
      humRemoval: true,
      highPass: true,
      normalize: true,
      deEsserEnabled: true,
      eqLow: 2,
      eqMid: 3,
      eqHighMid: 4,
      eqHigh: 3,
      compThreshold: -20,
      compRatio: 6,
      gateThreshold: -50,
    },
  },
  {
    id: 'asmr',
    label: 'ASMR',
    description: 'Preserve delicate detail & texture',
    icon: 'Sparkles',
    settings: {
      noiseReduction: 40,
      voicePresence: 45,
      clarity: 80,
      spectralGate: 20,
      deReverb: 15,
      deEsser: 25,
      compression: 20,
      humRemoval: true,
      highPass: true,
      normalize: true,
      deEsserEnabled: false,
      eqLow: 1,
      eqLowMid: 0,
      eqMid: 1,
      eqHighMid: 2,
      eqHigh: 4,
      compThreshold: -30,
      compRatio: 2,
      gateThreshold: -70,
    },
  },
  {
    id: 'neutral',
    label: 'Neutral',
    description: 'Transparent processing, minimal coloration',
    icon: 'Minus',
    settings: {
      noiseReduction: 35,
      voicePresence: 30,
      clarity: 35,
      spectralGate: 30,
      deReverb: 30,
      deEsser: 30,
      compression: 30,
      humRemoval: true,
      highPass: true,
      normalize: true,
      deEsserEnabled: true,
      eqLow: 0,
      eqLowMid: 0,
      eqMid: 0,
      eqHighMid: 0,
      eqHigh: 0,
      compThreshold: -24,
      compRatio: 3,
      gateThreshold: -60,
    },
  },
];
