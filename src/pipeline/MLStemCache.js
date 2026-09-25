/**
 * In-memory stem cache — skip repeat ONNX runs for the same file + model chain.
 * LRU capped to avoid RAM blowups on multi-file sessions.
 */
'use strict';

/** Max retained full stem results (each can be tens of MB). */
const MAX_ENTRIES = 2;

/** @type {Map<string, { clean: Float32Array[], noise: Float32Array[], sampleRate: number, passthrough: boolean }>} */
const _cache = new Map();

/** Bumped whenever the key derivation changes so old entries never alias. */
const KEY_SCHEMA = 'sk2';

/**
 * Two independent 32-bit FNV-style lanes over every sample's bit pattern of
 * every channel. A sparse sample of the waveform let an edited file with the
 * same name and length (e.g. a click removed between probe points) reuse the
 * previous file's stems. Cost is ~60 ms per 10 min of mono audio on desktop,
 * paid once per Process click, never per slider event.
 *
 * @param {Float32Array[]} channelData
 * @returns {string}
 */
function contentDigest(channelData) {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9e3779b9 | 0;
  for (let c = 0; c < channelData.length; c++) {
    const ch = channelData[c];
    const words = new Uint32Array(ch.buffer, ch.byteOffset, ch.length);
    h1 = Math.imul(h1 ^ (c + 1), 16777619);
    for (let i = 0; i < words.length; i++) {
      const v = words[i];
      h1 = Math.imul(h1 ^ v, 16777619);
      h2 = (Math.imul(h2 ^ v, 0x85ebca6b) + i) | 0;
    }
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Deterministic key over every input that changes the raw stems: the full
 * sample content, sample rate, channel layout, model chain (ordered) and the
 * Process-time Engineer revision. `sourceName` is appended for readability
 * and never substitutes for the content digest.
 *
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @param {string[]} modelIds
 * @param {string} [sourceName]
 * @param {string} [processingRevision] Process-time Engineer configuration.
 */
export function stemCacheKey(channelData, sampleRate, modelIds, sourceName = '', processingRevision = '') {
  const models = modelIds.join('→');
  const variant = processingRevision ? `|engineer:${processingRevision}` : '';
  const len = channelData[0]?.length || 0;
  const digest = len ? contentDigest(channelData) : '0';
  return `${KEY_SCHEMA}|${models}|${sampleRate}|${channelData.length}|${len}|${digest}|${sourceName}${variant}`;
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
