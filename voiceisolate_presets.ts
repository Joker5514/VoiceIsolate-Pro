export interface DSPParams {
  highPassFreq: number;
  lowPassFreq: number;
  compThreshold: number;
  compRatio: number;
  gateThreshold: number;
  denoiseMix: number;
  spectralGateDB: number;
  outputGain: number;
  clarityBoost: number;
  dryWetMix: number;
}

export interface VoiceIsolatePreset {
  id: string;
  name: string;
  params: DSPParams;
}

export const PRESETS: Record<string, VoiceIsolatePreset> = {
  'podcast-clean': {
    id: 'podcast-clean',
    name: 'Podcast Clean',
    params: {
      highPassFreq: 80,
      lowPassFreq: 16000,
      compThreshold: -24,
      compRatio: 3.5,
      gateThreshold: -48,
      denoiseMix: 0.35,
      spectralGateDB: 8,
      outputGain: 1.5,
      clarityBoost: 2,
      dryWetMix: 0.95
    }
  },
  'voice-stream': {
    id: 'voice-stream',
    name: 'Voice Stream',
    params: {
      highPassFreq: 100,
      lowPassFreq: 14000,
      compThreshold: -20,
      compRatio: 3,
      gateThreshold: -44,
      denoiseMix: 0.3,
      spectralGateDB: 6,
      outputGain: 1,
      clarityBoost: 1.5,
      dryWetMix: 0.9
    }
  },
  'aggressive-isolation': {
    id: 'aggressive-isolation',
    name: 'Aggressive Isolation',
    params: {
      highPassFreq: 120,
      lowPassFreq: 12000,
      compThreshold: -18,
      compRatio: 5,
      gateThreshold: -38,
      denoiseMix: 0.85,
      spectralGateDB: 14,
      outputGain: 2,
      clarityBoost: 3,
      dryWetMix: 1.0
    }
  }
};

export const DEFAULT_PRESET_ID = 'podcast-clean';
