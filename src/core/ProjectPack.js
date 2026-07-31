/**
 * Portable project pack (.vippack) for desktop ↔ Android / PWA handoff.
 * 100% local — user-mediated export/import only (share sheet / file pick).
 *
 * Binary layout (little-endian):
 *   magic u32  0x56505031  ("VPP1")
 *   version u16 = 1
 *   flags u16 = 0
 *   manifestLen u32
 *   manifest JSON (utf-8)
 *   for each entry:
 *     nameLen u16, name utf-8
 *     dataLen u32, data bytes
 */
'use strict';

import * as FileLibrary from './FileLibrary.js';
import * as ProjectStore from './ProjectStore.js';
import { readSourceBlob, writeSourceBlob, blobToFile } from './storage/BlobStore.js';

const MAGIC = 0x56505031; // VPP1
const VERSION = 1;

/**
 * @param {string} projectId
 * @returns {Promise<Blob>}
 */
export async function exportProjectPack(projectId) {
  const project = await ProjectStore.getProject(projectId);
  if (!project) throw new Error('[VIP][ProjectPack] project not found');

  const files = [];
  const entries = [];

  for (const fileId of project.sourceFileIds || []) {
    const meta = await FileLibrary.getFileMeta(fileId);
    if (!meta) continue;
    let blob = null;
    if (meta.blobRef) blob = await readSourceBlob(meta.blobRef);
    if (!blob) continue;
    const name = `sources/${fileId}/${meta.originalFilename || 'audio.bin'}`;
    const ab = await blob.arrayBuffer();
    entries.push({ name, data: new Uint8Array(ab) });
    files.push({
      id: fileId,
      originalFilename: meta.originalFilename,
      mimeType: meta.mimeType,
      size: meta.size,
      duration: meta.duration,
      sampleRate: meta.sampleRate,
      channels: meta.channels,
      tags: meta.tags || [],
      path: name,
    });
  }

  const manifest = {
    format: 'vippack',
    version: VERSION,
    exportedAt: Date.now(),
    project: {
      name: project.name,
      description: project.description || '',
      savedParams: project.savedParams || {},
      activePreset: project.activePreset || null,
      sourceFileIds: project.sourceFileIds || [],
    },
    files,
  };

  return buildPackBlob(manifest, entries);
}

/**
 * @param {object} manifest
 * @param {Array<{ name: string, data: Uint8Array }>} entries
 * @returns {Blob}
 */
export function buildPackBlob(manifest, entries) {
  const manBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const parts = [];
  const header = new ArrayBuffer(12);
  const hv = new DataView(header);
  hv.setUint32(0, MAGIC, true);
  hv.setUint16(4, VERSION, true);
  hv.setUint16(6, 0, true);
  hv.setUint32(8, manBytes.byteLength, true);
  parts.push(header, manBytes);

  for (const ent of entries) {
    const nameBytes = new TextEncoder().encode(ent.name);
    const nh = new ArrayBuffer(6);
    const nv = new DataView(nh);
    nv.setUint16(0, nameBytes.byteLength, true);
    nv.setUint32(2, ent.data.byteLength, true);
    parts.push(nh, nameBytes, ent.data);
  }

  return new Blob(parts, { type: 'application/octet-stream' });
}

/**
 * @param {ArrayBuffer|Blob} input
 * @returns {Promise<{ manifest: object, files: Map<string, Uint8Array> }>}
 */
export async function parseProjectPack(input) {
  const ab = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  const view = new DataView(ab);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new Error('[VIP][ProjectPack] invalid magic — not a .vippack file');
  }
  const version = view.getUint16(4, true);
  if (version !== VERSION) {
    throw new Error(`[VIP][ProjectPack] unsupported pack version ${version}`);
  }
  const manLen = view.getUint32(8, true);
  let offset = 12;
  const manBytes = new Uint8Array(ab, offset, manLen);
  offset += manLen;
  const manifest = JSON.parse(new TextDecoder().decode(manBytes));
  /** @type {Map<string, Uint8Array>} */
  const files = new Map();
  while (offset + 6 <= ab.byteLength) {
    const nameLen = view.getUint16(offset, true);
    const dataLen = view.getUint32(offset + 2, true);
    offset += 6;
    const name = new TextDecoder().decode(new Uint8Array(ab, offset, nameLen));
    offset += nameLen;
    const data = new Uint8Array(ab, offset, dataLen);
    offset += dataLen;
    files.set(name, data.slice());
  }
  return { manifest, files };
}

/**
 * Import a pack into local ProjectStore + FileLibrary.
 * @param {ArrayBuffer|Blob|File} input
 * @returns {Promise<{ projectId: string, fileIds: string[] }>}
 */
export async function importProjectPack(input) {
  const { manifest, files } = await parseProjectPack(input);
  const proj = await ProjectStore.createProject({
    name: manifest.project?.name || 'Imported project',
    description: manifest.project?.description || '',
  });
  await ProjectStore.updateProject(proj.projectId, {
    savedParams: manifest.project?.savedParams || {},
    activePreset: manifest.project?.activePreset || null,
  });

  const fileIds = [];
  for (const f of manifest.files || []) {
    const raw = files.get(f.path);
    if (!raw) continue;
    const blob = new Blob([raw], { type: f.mimeType || 'application/octet-stream' });
    const file = blobToFile(blob, {
      originalFilename: f.originalFilename || 'import.bin',
      mimeType: f.mimeType,
    });
    const meta = await FileLibrary.importFile(file, {
      mode: 'project',
      projectId: proj.projectId,
      tags: f.tags || [],
    });
    await FileLibrary.updateFileMeta(meta.id, {
      duration: f.duration ?? null,
      sampleRate: f.sampleRate ?? null,
      channels: f.channels ?? null,
      projectId: proj.projectId,
    });
    await ProjectStore.linkSourceFile(proj.projectId, meta.id);
    fileIds.push(meta.id);
  }

  return { projectId: proj.projectId, fileIds };
}

/**
 * Trigger a browser download of a pack blob.
 * @param {Blob} blob
 * @param {string} filename
 */
export function downloadPackBlob(blob, filename = 'project.vippack') {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default {
  exportProjectPack,
  importProjectPack,
  parseProjectPack,
  buildPackBlob,
  downloadPackBlob,
};
