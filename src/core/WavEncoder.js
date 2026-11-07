/**
 * ESM facade for the single WAV encoder. The implementation lives in
 * wav-encoder-impl.js so classic scripts and workers load the same bytes.
 */
import './wav-encoder-impl.js';

const api = globalThis.VIPWavEncoder;

export function normalizeWavOptions(options) {
  return api.normalizeOptions(options);
}

export function planWav(numChannels, frames, sampleRate, options) {
  return api.planWav(numChannels, frames, sampleRate, options);
}

export function writeWavHeader(view, plan) {
  return api.writeWavHeader(view, plan);
}

export function createQuantizeState(numChannels, options, plan) {
  return api.createQuantizeState(numChannels, options, plan);
}

export function quantizeRange(view, channels, from, to, plan, state) {
  return api.quantizeRange(view, channels, from, to, plan, state);
}

export function createTruePeakMeter() {
  return api.createTruePeakMeter();
}

export function gainForTruePeak(peak, ceilingDb) {
  return api.gainForTruePeak(peak, ceilingDb);
}

export function measureTruePeak(channels) {
  return api.measureTruePeak(channels);
}

export function limitTruePeakInPlace(data, ceilingDb) {
  return api.limitTruePeakInPlace(data, ceilingDb);
}

export function linearTruePeakCeiling(ceilingDb) {
  return api.linearCeiling(ceilingDb);
}

export function encodeWavArrayBuffer(channels, sampleRate, options) {
  return api.encodeWavArrayBuffer(channels, sampleRate, options);
}

export function wavHeaderBytes(numChannels, sampleRate, frames, bitDepth) {
  return api.wavHeaderBytes(numChannels, sampleRate, frames, bitDepth);
}

export function interleaveFloat32(channels) {
  return api.interleaveFloat32(channels);
}

export default api;
