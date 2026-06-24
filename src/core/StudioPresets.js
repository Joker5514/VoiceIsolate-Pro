'use strict';

const PRESET_DEFINITIONS = Object.freeze([
  {
    id: 'voice-clarity',
    name: 'Voice Clarity',
    description: 'Balanced cleanup for spoken-word recordings.',
    values: Object.freeze({
      noiseReductionSlider: 82,
      voiceLevelSlider: 112,
      volumeSlider: 92,
      eqLowSlider: -3,
      eqHighSlider: 6,
    }),
  },
  {
    id: 'podcast-clean',
    name: 'Podcast Clean',
    description: 'Gentle denoise with a brighter top end for podcasts.',
    values: Object.freeze({
      noiseReductionSlider: 74,
      voiceLevelSlider: 108,
      volumeSlider: 90,
      eqLowSlider: -2,
      eqHighSlider: 4,
    }),
  },
  {
    id: 'forensic-extract',
    name: 'Forensic Extract',
    description: 'Maximum isolation for difficult surveillance material.',
    values: Object.freeze({
      noiseReductionSlider: 96,
      voiceLevelSlider: 126,
      volumeSlider: 94,
      eqLowSlider: -6,
      eqHighSlider: 8,
    }),
  },
  {
    id: 'music-vocal',
    name: 'Music Vocal',
    description: 'Keeps vocal presence while preserving musical body.',
    values: Object.freeze({
      noiseReductionSlider: 58,
      voiceLevelSlider: 118,
      volumeSlider: 95,
      eqLowSlider: 2,
      eqHighSlider: 5,
    }),
  },
  {
    id: 'whisper-boost',
    name: 'Whisper Boost',
    description: 'Extra gain and air for quiet or distant speech.',
    values: Object.freeze({
      noiseReductionSlider: 88,
      voiceLevelSlider: 138,
      volumeSlider: 96,
      eqLowSlider: -5,
      eqHighSlider: 10,
    }),
  },
  {
    id: 'phone-radio',
    name: 'Phone/Radio',
    description: 'Sharper presence for narrow-band communications.',
    values: Object.freeze({
      noiseReductionSlider: 84,
      voiceLevelSlider: 120,
      volumeSlider: 91,
      eqLowSlider: -8,
      eqHighSlider: 9,
    }),
  },
  {
    id: 'live-performance',
    name: 'Live Performance',
    description: 'Moderate cleanup that keeps ambience and dynamics.',
    values: Object.freeze({
      noiseReductionSlider: 48,
      voiceLevelSlider: 106,
      volumeSlider: 93,
      eqLowSlider: 1,
      eqHighSlider: 3,
    }),
  },
  {
    id: 'surveillance',
    name: 'Surveillance',
    description: 'Aggressive denoise tuned for noisy field captures.',
    values: Object.freeze({
      noiseReductionSlider: 92,
      voiceLevelSlider: 130,
      volumeSlider: 95,
      eqLowSlider: -7,
      eqHighSlider: 7,
    }),
  },
]);

const PRESET_BY_ID = Object.freeze(
  Object.fromEntries(PRESET_DEFINITIONS.map((preset) => [preset.id, preset]))
);

const PRESET_BY_NAME = Object.freeze(
  Object.fromEntries(PRESET_DEFINITIONS.map((preset) => [preset.name, preset]))
);

export const STUDIO_PRESETS = PRESET_DEFINITIONS;

export function listPresets() {
  return STUDIO_PRESETS.slice();
}

export function getPreset(idOrName) {
  if (typeof idOrName !== 'string' || !idOrName.trim()) {
    throw new TypeError('[VIP][StudioPresets] Preset id or name is required.');
  }
  const key = idOrName.trim();
  const preset = PRESET_BY_ID[key] || PRESET_BY_NAME[key];
  if (!preset) {
    throw new Error(`[VIP][StudioPresets] Unknown preset '${key}'.`);
  }
  return preset;
}

export function isPresetId(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(PRESET_BY_ID, id);
}

export default STUDIO_PRESETS;