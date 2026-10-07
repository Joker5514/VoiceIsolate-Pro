'use strict';
/** Processing profiles shared by the quality gate and the quality matrix. */
const { engineerConfig } = require('./engineer-config.cjs');

/** Scenario ids the gate pins (a subset of scenarios.cjs). */
const GATE_SCENARIOS = Object.freeze([
  'clean-speech', 'white-5db', 'hvac-5db', 'hum-10db', 'music-0db',
  'whisper-clean', 'whisper-white-10db', 'silence', 'noise-only',
]);

async function profiles() {
  return [
    { id: 'landing', modelIds: ['bsrnn_vocals'], processingConfig: null },
    { id: 'engineer', modelIds: ['bsrnn_vocals'], processingConfig: await engineerConfig() },
    { id: 'maximum', modelIds: ['bsrnn_vocals', 'rnnoise'], processingConfig: null },
  ];
}

module.exports = { profiles, GATE_SCENARIOS };
