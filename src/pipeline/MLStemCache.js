/**
 * In-memory stem cache — skip repeat ONNX runs for the same file + model chain.
 */
'use strict';

/** @type {Map<string, { clean: Float32Array[], noise: Float32Array[], sampleRate: number, passthrough: boolean }>} */
const _cache = new Map();

/**
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @param {string[]} modelIds
 * @param {string} [sourceName]
 */
export function stemCacheKey(channelData, sampleRate, modelIds, sourceName = '') {
  const models = [...modelIds].sort().join('+');
  const ch0 = channelData[0];
  if (!ch0?.length) return `${models}|${sampleRate}|0|${sourceName}`;
  const len = ch0.length;
  const nCh = channelData.length;
  const mid = ch0[len >> 1] ?? 0;
  const end = ch0[len - 1] ?? 0;
  let sum = 0;
  const step = Math.max(1, Math.floor(len / 64));
  for (let i = 0; i < len; i += step) sum += Math.abs(ch0[i]);
  return `${models}|${sampleRate}|${nCh}|${len}|${sum.toFixed(4)}|${ch0[0]}|${mid}|${end}|${sourceName}`;
}

export function getCachedStems(key) {
  return _cache.get(key) || null;
}

export function setCachedStems(key, result) {
  if (!key || !result || result.passthrough) return;
  _cache.set(key, {
    clean: result.clean.map((c) => new Float32Array(c)),
    noise: result.noise.map((c) => new Float32Array(c)),
    sampleRate: result.sampleRate,
    passthrough: false,
  });
}

export function clearStemCache() {
  _cache.clear();
}

export function getStemCacheSize() {
  return _cache.size;
}