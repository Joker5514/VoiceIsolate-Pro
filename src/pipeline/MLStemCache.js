/**
 * In-memory stem cache — skip repeat ONNX runs for the same file + model chain.
 * LRU capped to avoid RAM blowups on multi-file sessions.
 */
'use strict';

import { detectPerformanceTier, tierBudgets } from '../core/PerformanceTier.js';
import { createAbortableYield, createYieldBudget } from './ui-yield.js';

/** Max retained full stem results (each can be tens of MB). */
const MAX_ENTRIES = 2;

/**
 * Total bytes the cache may retain, from the device's performance tier
 * (unbounded on desktop, 384 MB on touch/4 GB devices, 160 MB on 2 GB ones).
 * Resolved on first use so Node tests and workers can import this module.
 * @type {number|null}
 */
let _byteBudget = null;

/** @type {Map<string, { clean: Float32Array[], noise: Float32Array[], sampleRate: number, passthrough: boolean }>} */
const _cache = new Map();
/** Bumped by clearStemCache so an in-flight async store is discarded. */
let _cacheGen = 0;

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

/** 256 Ki samples per slice: ~2 ms on desktop, ~10 ms on a 4x-throttled phone. */
const DIGEST_SLICE = 1 << 18;

/**
 * {@link contentDigest} with `maybeYield()` between slices; identical result.
 * Done in one task it was 303 ms for 5 min of stereo on a 4x CPU-throttled
 * mobile profile, scaling linearly (~1.8 s at 30 min).
 * @param {Float32Array[]} channelData
 * @param {() => Promise<void>} maybeYield
 */
async function contentDigestAsync(channelData, maybeYield) {
  let h1 = 0x811c9dc5 | 0;
  let h2 = 0x9e3779b9 | 0;
  for (let c = 0; c < channelData.length; c++) {
    const ch = channelData[c];
    const words = new Uint32Array(ch.buffer, ch.byteOffset, ch.length);
    h1 = Math.imul(h1 ^ (c + 1), 16777619);
    for (let start = 0; start < words.length; start += DIGEST_SLICE) {
      const end = Math.min(words.length, start + DIGEST_SLICE);
      for (let i = start; i < end; i++) {
        const v = words[i];
        h1 = Math.imul(h1 ^ v, 16777619);
        h2 = (Math.imul(h2 ^ v, 0x85ebca6b) + i) | 0;
      }
      await maybeYield();
    }
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/**
 * Digests memoised per decoded buffer. Ingested channel arrays are never
 * mutated after decode (callers copy before transferring them to a worker),
 * so a repeat Process click on the same file skips the full-content pass.
 * @type {WeakMap<Float32Array, { channels: Float32Array[], digest: string }>}
 */
const _digests = new WeakMap();
let _digestComputations = 0;

/** Full-content hash passes run so far (tests assert memoisation with it). */
export function getDigestComputationCount() {
  return _digestComputations;
}

function memoHit(channelData) {
  const hit = _digests.get(channelData[0]);
  if (hit && hit.channels.length === channelData.length && hit.channels.every((ch, i) => ch === channelData[i])) {
    return hit.digest;
  }
  return null;
}

function memoStore(channelData, digest) {
  _digestComputations += 1;
  _digests.set(channelData[0], { channels: [...channelData], digest });
  return digest;
}

function memoDigest(channelData) {
  return memoHit(channelData) ?? memoStore(channelData, contentDigest(channelData));
}

function formatKey(channelData, sampleRate, modelIds, processingRevision, digest) {
  const models = modelIds.join('→');
  const variant = processingRevision ? `|engineer:${processingRevision}` : '';
  const len = channelData[0]?.length || 0;
  return `${KEY_SCHEMA}|${models}|${sampleRate}|${channelData.length}|${len}|${digest}${variant}`;
}

/**
 * Deterministic key over every input that changes the raw stems: the full
 * sample content, sample rate, channel layout, model chain (ordered) and the
 * Process-time Engineer revision. The file name is deliberately not part of
 * it: identical audio under another name reuses stems, and a name can never
 * stand in for content.
 *
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @param {string[]} modelIds
 * @param {string} [_sourceName] Accepted for caller compatibility; unused.
 * @param {string} [processingRevision] Process-time Engineer configuration.
 */
export function stemCacheKey(channelData, sampleRate, modelIds, _sourceName = '', processingRevision = '') {
  const digest = channelData[0]?.length ? memoDigest(channelData) : '0';
  return formatKey(channelData, sampleRate, modelIds, processingRevision, digest);
}

/**
 * {@link stemCacheKey} for the main thread: the same key, but the
 * full-content hash yields between slices instead of blocking one task.
 * Shares the per-buffer memo with the synchronous version.
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @param {string[]} modelIds
 * @param {string} [_sourceName]
 * @param {string} [processingRevision]
 * @param {{ maybeYield?: () => Promise<void>, signal?: AbortSignal }} [opts]
 *   signal: an abort stops the hash at its next slice (AbortError)
 * @returns {Promise<string>}
 */
export async function stemCacheKeyAsync(channelData, sampleRate, modelIds, _sourceName = '', processingRevision = '', opts = {}) {
  let digest = '0';
  if (channelData[0]?.length) {
    digest = memoHit(channelData)
      ?? memoStore(channelData, await contentDigestAsync(channelData, abortAware(opts)));
  }
  return formatKey(channelData, sampleRate, modelIds, processingRevision, digest);
}

export function getCachedStems(key) {
  if (!key || !_cache.has(key)) return null;
  // LRU touch
  const val = _cache.get(key);
  _cache.delete(key);
  _cache.set(key, val);
  return val || null;
}

function abortAware({ maybeYield, signal } = {}) {
  if (!maybeYield) return signal ? createAbortableYield(signal) : createYieldBudget();
  if (!signal) return maybeYield;
  return async () => {
    await maybeYield();
    if (signal.aborted) {
      throw typeof DOMException !== 'undefined'
        ? new DOMException('Processing cancelled', 'AbortError')
        : Object.assign(new Error('Processing cancelled'), { name: 'AbortError' });
    }
  };
}

function channelBytes(channels) {
  let n = 0;
  for (const c of channels || []) n += c?.byteLength || 0;
  return n;
}

function entryBytes(result) {
  return channelBytes(result.clean) + channelBytes(result.noise);
}

function byteBudget() {
  if (_byteBudget === null) _byteBudget = tierBudgets(detectPerformanceTier()).stemCacheBytes;
  return _byteBudget;
}

/**
 * Override the tier-derived byte budget (tests, diagnostics). Evicts LRU
 * entries that no longer fit. `null` re-derives it from the device tier.
 * @param {number|null} bytes
 */
export function setStemCacheByteBudget(bytes) {
  _byteBudget = bytes === null ? null : Math.max(0, Number(bytes) || 0);
  evict();
}

/** Bytes currently retained by cached stems. */
export function getStemCacheBytes() {
  let n = 0;
  for (const v of _cache.values()) n += entryBytes(v);
  return n;
}

/**
 * A result too large for the budget is not cached (no copy is made).
 * One that fits first evicts LRU entries until it can be added within the
 * budget, so the cache never holds old entries plus the new copies at once.
 */
function fits(result, key) {
  const bytes = entryBytes(result);
  const budget = byteBudget();
  if (bytes > budget) return false;
  _cache.delete(key);
  while (_cache.size > 0 && getStemCacheBytes() + bytes > budget) {
    _cache.delete(_cache.keys().next().value);
  }
  return true;
}

export function setCachedStems(key, result) {
  if (!key || !result || result.passthrough || !fits(result, key)) return;
  // Always store independent copies so callers can mutate/transfer sources safely.
  const clean = result.clean.map((c) => new Float32Array(c));
  const noise = (result.noise || []).map((c) => new Float32Array(c));
  storeEntry(key, clean, noise, result.sampleRate);
}

/**
 * {@link setCachedStems} with a caller-supplied (cooperative) channel copy,
 * e.g. ui-yield's copyFloat32Channel. The stored arrays are still independent
 * copies; only the copy is spread across tasks instead of blocking one.
 * @param {string} key
 * @param {{ clean: Float32Array[], noise?: Float32Array[], sampleRate: number, passthrough?: boolean }} result
 * @param {(src: Float32Array) => Promise<Float32Array>} copyChannel
 */
export async function setCachedStemsAsync(key, result, copyChannel) {
  if (!key || !result || result.passthrough || !fits(result, key)) return;
  // clearStemCache() during the copy (source changed) must not be undone.
  const gen = _cacheGen;
  const clean = [];
  for (const c of result.clean) clean.push(await copyChannel(c));
  const noise = [];
  for (const c of result.noise || []) noise.push(await copyChannel(c));
  if (gen !== _cacheGen) return;
  storeEntry(key, clean, noise, result.sampleRate);
}

function storeEntry(key, clean, noise, sampleRate) {
  if (_cache.has(key)) _cache.delete(key);
  _cache.set(key, {
    clean,
    noise,
    sampleRate,
    passthrough: false,
  });
  evict();
}

function evict() {
  const budget = byteBudget();
  while (_cache.size > MAX_ENTRIES || (_cache.size > 0 && getStemCacheBytes() > budget)) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
}

export function clearStemCache() {
  _cacheGen += 1;
  _cache.clear();
}

export function getStemCacheSize() {
  return _cache.size;
}

export { MAX_ENTRIES as ML_STEM_CACHE_MAX };
