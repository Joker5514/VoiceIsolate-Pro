/**
 * Durable derived caches: ML stems + analysis JSON.
 * Stored as blobs (OPFS preferred / IDB fallback) — not permanent full-session PCM
 * for arbitrary files; only successful process/analyze products the user paid compute for.
 *
 * 100% local.
 */
'use strict';

import {
  writeSourceBlob,
  readSourceBlob,
  deleteSourceBlob,
} from './BlobStore.js';
import { openIdb, idbGet, idbPut, idbDelete, idbTxDone } from './openIdb.js';
import {
  MAX_DURABLE_STEM_BYTES,
  MAX_DURABLE_STEM_SAMPLES,
  estimateStemPackBytes,
} from './memory-limits.js';

const META_DB = 'vip-derived-cache';
const META_VER = 1;
const META_STORE = 'entries';

/**
 * @typedef {{ key: string, kind: 'stems'|'analysis', fileId: string, blobRef: {backend:string,path:string}, createdAt: number, modelIds?: string[], sampleRate?: number, processingRevision?: string }} DerivedMeta
 */

function openMeta() {
  return openIdb(META_DB, META_VER, (db) => {
    if (!db.objectStoreNames.contains(META_STORE)) {
      const s = db.createObjectStore(META_STORE, { keyPath: 'key' });
      s.createIndex('fileId', 'fileId', { unique: false });
    }
  });
}

/**
 * @param {string} fileId
 * @param {string[]} modelIds
 * @param {string} [processingRevision]
 */
export function stemDurableKey(fileId, modelIds = [], processingRevision = '') {
  const chain = (modelIds || []).join('→') || 'default';
  const variant = processingRevision ? `:engineer-${String(processingRevision).replace(/[^a-zA-Z0-9._-]/g, '_')}` : '';
  return `stems:${fileId}:${chain}${variant}`;
}

/**
 * @param {string} fileId
 */
export function analysisDurableKey(fileId) {
  return `analysis:${fileId}`;
}

/**
 * Pack clean/noise Float32 channels into a single ArrayBuffer.
 * Layout:
 *   magic "VSTEM1\0" (8)
 *   sampleRate u32, nClean u16, nNoise u16, length u32
 *   clean ch0..n, noise ch0..n as float32
 *
 * @param {{ clean: Float32Array[], noise: Float32Array[], sampleRate: number }} result
 * @returns {ArrayBuffer}
 */
/**
 * @returns {boolean}
 */
export function canPersistStems(result) {
  const clean = result?.clean || [];
  const noise = result?.noise || [];
  const length = clean[0]?.length || noise[0]?.length || 0;
  if (!length || length > MAX_DURABLE_STEM_SAMPLES) return false;
  const bytes = estimateStemPackBytes(clean.length, noise.length, length);
  return bytes > 0 && bytes <= MAX_DURABLE_STEM_BYTES;
}

export function encodeStemPack(result) {
  const clean = result.clean || [];
  const noise = result.noise || [];
  const nClean = clean.length;
  const nNoise = noise.length;
  const length = clean[0]?.length || noise[0]?.length || 0;
  if (!length || length > MAX_DURABLE_STEM_SAMPLES) {
    throw new RangeError('[VIP][DerivedCache] stem pack exceeds sample limit');
  }
  const sampleRate = result.sampleRate || 48000;
  const headerBytes = 20; // 8 magic + 4 sr + 2 nClean + 2 nNoise + 4 length
  const packBytes = estimateStemPackBytes(nClean, nNoise, length);
  if (packBytes > MAX_DURABLE_STEM_BYTES) {
    throw new RangeError('[VIP][DerivedCache] stem pack exceeds byte limit');
  }
  const totalFloats = (nClean + nNoise) * length;
  const buf = new ArrayBuffer(headerBytes + totalFloats * 4);
  const view = new DataView(buf);
  const magic = [0x56, 0x53, 0x54, 0x45, 0x4d, 0x31, 0x00, 0x00]; // VSTEM1\0\0
  magic.forEach((b, i) => view.setUint8(i, b));
  view.setUint32(8, sampleRate, true);
  view.setUint16(12, nClean, true);
  view.setUint16(14, nNoise, true);
  view.setUint32(16, length, true);
  const f32 = new Float32Array(buf, headerBytes);
  let o = 0;
  for (let c = 0; c < nClean; c++) {
    f32.set(clean[c].length === length ? clean[c] : clean[c].subarray(0, length), o);
    o += length;
  }
  for (let c = 0; c < nNoise; c++) {
    f32.set(noise[c].length === length ? noise[c] : noise[c].subarray(0, length), o);
    o += length;
  }
  return buf;
}

/**
 * @param {ArrayBuffer} buf
 * @returns {{ clean: Float32Array[], noise: Float32Array[], sampleRate: number, passthrough: false }|null}
 */
export function decodeStemPack(buf) {
  if (!buf || buf.byteLength < 20) return null;
  const view = new DataView(buf);
  if (view.getUint8(0) !== 0x56 || view.getUint8(1) !== 0x53) return null;
  const sampleRate = view.getUint32(8, true);
  const nClean = view.getUint16(12, true);
  const nNoise = view.getUint16(14, true);
  const length = view.getUint32(16, true);
  const headerBytes = 20;
  if (!Number.isFinite(length) || length <= 0 || length > MAX_DURABLE_STEM_SAMPLES) return null;
  if (nClean > 8 || nNoise > 8) return null;
  const need = estimateStemPackBytes(nClean, nNoise, length);
  if (need > MAX_DURABLE_STEM_BYTES || buf.byteLength < need) return null;
  // Views into the same buffer — avoid doubling RAM with per-channel copies.
  // Callers that transfer to workers must copy themselves.
  const f32 = new Float32Array(buf, headerBytes, (nClean + nNoise) * length);
  const clean = [];
  const noise = [];
  let o = 0;
  for (let c = 0; c < nClean; c++) {
    clean.push(f32.subarray(o, o + length));
    o += length;
  }
  for (let c = 0; c < nNoise; c++) {
    noise.push(f32.subarray(o, o + length));
    o += length;
  }
  return { clean, noise, sampleRate, passthrough: false, _backing: buf };
}

/**
 * @param {string} fileId
 * @param {string[]} modelIds
 * @param {{ clean: Float32Array[], noise: Float32Array[], sampleRate: number }} result
 * @param {string} [processingRevision]
 */
export async function saveStemsDurable(fileId, modelIds, result, processingRevision = '') {
  if (!fileId || !result?.clean?.length) return null;
  if (!canPersistStems(result)) {
    return null; // skip silently — too large for browser storage / RAM
  }
  const key = stemDurableKey(fileId, modelIds, processingRevision);
  let ab;
  try {
    ab = encodeStemPack(result);
  } catch {
    return null;
  }
  const blob = new Blob([ab], { type: 'application/octet-stream' });
  // Release encode buffer reference ASAP after Blob takes ownership.
  ab = null;
  const blobRef = await writeSourceBlob(`derived-${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`, blob);
  /** @type {DerivedMeta} */
  const meta = {
    key,
    kind: 'stems',
    fileId,
    blobRef,
    createdAt: Date.now(),
    modelIds: modelIds || [],
    sampleRate: result.sampleRate,
    processingRevision: processingRevision || undefined,
  };
  const db = await openMeta();
  const tx = db.transaction(META_STORE, 'readwrite');
  await idbPut(tx.objectStore(META_STORE), meta);
  await idbTxDone(tx);
  return meta;
}

/**
 * @param {string} fileId
 * @param {string[]} modelIds
 * @param {string} [processingRevision]
 */
export async function loadStemsDurable(fileId, modelIds, processingRevision = '') {
  if (!fileId) return null;
  const key = stemDurableKey(fileId, modelIds, processingRevision);
  try {
    const db = await openMeta();
    const tx = db.transaction(META_STORE, 'readonly');
    const meta = await idbGet(tx.objectStore(META_STORE), key);
    if (!meta?.blobRef) return null;
    const blob = await readSourceBlob(meta.blobRef);
    if (!blob) return null;
    const ab = await blob.arrayBuffer();
    return decodeStemPack(ab);
  } catch {
    return null;
  }
}

/**
 * @param {string} fileId
 * @param {object} analysis
 */
export async function saveAnalysisDurable(fileId, analysis) {
  if (!fileId || !analysis) return null;
  const key = analysisDurableKey(fileId);
  // Compact: drop huge typed arrays / frame matrices that blow IDB + RAM.
  // Keep segments, recommendations, joint plan, duration — not raw features.
  const safe = compactAnalysisForStorage(analysis);
  let json;
  try {
    json = JSON.stringify(safe);
  } catch {
    return null;
  }
  // Cap analysis JSON (~4 MB) to avoid crash on pathological objects.
  if (json.length > 4 * 1024 * 1024) return null;
  const blob = new Blob([json], { type: 'application/json' });
  const blobRef = await writeSourceBlob(`derived-${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`, blob);
  const meta = {
    key,
    kind: 'analysis',
    fileId,
    blobRef,
    createdAt: Date.now(),
  };
  const db = await openMeta();
  const tx = db.transaction(META_STORE, 'readwrite');
  await idbPut(tx.objectStore(META_STORE), meta);
  await idbTxDone(tx);
  return meta;
}

/**
 * @param {string} fileId
 * @returns {Promise<object|null>}
 */
export async function loadAnalysisDurable(fileId) {
  if (!fileId) return null;
  const key = analysisDurableKey(fileId);
  try {
    const db = await openMeta();
    const tx = db.transaction(META_STORE, 'readonly');
    const meta = await idbGet(tx.objectStore(META_STORE), key);
    if (!meta?.blobRef) return null;
    const blob = await readSourceBlob(meta.blobRef);
    if (!blob) return null;
    return JSON.parse(await blob.text());
  } catch {
    return null;
  }
}

/**
 * @param {string} fileId
 */
export async function deleteDerivedForFile(fileId) {
  if (!fileId) return;
  try {
    const db = await openMeta();
    const tx = db.transaction(META_STORE, 'readonly');
    const all = await new Promise((resolve, reject) => {
      const req = tx.objectStore(META_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const mine = all.filter((e) => e.fileId === fileId);
    for (const e of mine) {
      if (e.blobRef) await deleteSourceBlob(e.blobRef);
      const w = db.transaction(META_STORE, 'readwrite');
      await idbDelete(w.objectStore(META_STORE), e.key);
      await idbTxDone(w);
    }
  } catch {
    // ignore
  }
}

/**
 * Keep only lightweight analysis fields for durable storage.
 * @param {object} analysis
 */
export function compactAnalysisForStorage(analysis) {
  if (!analysis || typeof analysis !== 'object') return {};
  const pick = (obj, keys) => {
    const out = {};
    for (const k of keys) {
      if (obj[k] !== undefined) out[k] = obj[k];
    }
    return out;
  };
  const base = pick(analysis, [
    'duration',
    'sampleRate',
    'recommendedPreset',
    'confidence',
    'summary',
    'speechSegments',
    'whisperRegions',
    'noiseSegments',
    'musicSegments',
    'humSegments',
    'impulseRegions',
    'recommendations',
    'jointPlan',
    'platformProfile',
    'version',
  ]);
  // Clamp segment arrays
  for (const k of ['speechSegments', 'whisperRegions', 'noiseSegments', 'musicSegments', 'humSegments', 'impulseRegions', 'recommendations']) {
    if (Array.isArray(base[k]) && base[k].length > 500) {
      base[k] = base[k].slice(0, 500);
    }
  }
  return base;
}

export default {
  stemDurableKey,
  analysisDurableKey,
  canPersistStems,
  encodeStemPack,
  decodeStemPack,
  saveStemsDurable,
  loadStemsDurable,
  saveAnalysisDurable,
  loadAnalysisDurable,
  deleteDerivedForFile,
  compactAnalysisForStorage,
};
