/**
 * In-memory stem cache — skip repeat ONNX runs for the same file + model chain.
 * LRU capped to avoid RAM blowups on multi-file sessions.
 */
'use strict';

/** Max retained full stem results (each can be tens of MB). */
const MAX_ENTRIES = 2;

/** @type {Map<string, { clean: Float32Array[], noise: Float32Array[], sampleRate: number, passthrough: boolean }>} */
const _cache = new Map();

/**
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @param {string[]} modelIds
 * @param {string} [sourceName]
 * @param {string} [processingRevision] Process-time Engineer configuration.
 */
export function stemCacheKey(channelData, sampleRate, modelIds, sourceName = '', processingRevision = '') {
  const models = modelIds.join('→');
  const variant = processingRevision ? `|engineer:${processingRevision}` : '';
  const ch0 = channelData[0];
  if (!ch0?.length) return `${models}|${sampleRate}|0|${sourceName}${variant}`;
  const len = ch0.length;
  const nCh = channelData.length;
  const mid = ch0[len >> 1] ?? 0;
  const end = ch0[len - 1] ?? 0;
  let sum = 0;
  const step = Math.max(1, Math.floor(len / 64));
  for (let i = 0; i < len; i += step) sum += Math.abs(ch0[i]);
  return `${models}|${sampleRate}|${nCh}|${len}|${sum.toFixed(4)}|${ch0[0]}|${mid}|${end}|${sourceName}${variant}`;
}

export function getCachedStems(key) {
  if (!key || !_cache.has(key)) return null;
  // LRU touch
  const val = _cache.get(key);
  _cache.delete(key);
  _cache.set(key, val);
  return val || null;
}

export function setCachedStems(key, result) {
  if (!key || !result || result.passthrough) return;
  // Always store independent copies so callers can mutate/transfer sources safely.
  const clean = result.clean.map((c) => new Float32Array(c));
  const noise = (result.noise || []).map((c) => new Float32Array(c));
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, {
    clean,
    noise,
    sampleRate: result.sampleRate,
    passthrough: false,
  });
  while (_cache.size > MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

export function clearStemCache() {
  _cache.clear();
}

export function getStemCacheSize() {
  return _cache.size;
}

export { MAX_ENTRIES as ML_STEM_CACHE_MAX };
