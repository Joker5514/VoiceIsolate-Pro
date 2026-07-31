/**
 * Named projects that link library source files + optional output refs.
 * 100% local IndexedDB.
 */
'use strict';

import { openIdb, idbGet, idbPut, idbDelete, idbGetAll, idbTxDone } from './storage/openIdb.js';

const DB_NAME = 'vip-projects';
const DB_VERSION = 1;
const STORE = 'projects';

/**
 * @typedef {object} Project
 * @property {string} projectId
 * @property {string} name
 * @property {string} description
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string[]} sourceFileIds
 * @property {Array<{ id: string, kind: string, fileId?: string, label?: string }>} outputs
 * @property {object} savedParams
 * @property {string|null} activePreset
 */

function open() {
  return openIdb(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      const s = db.createObjectStore(STORE, { keyPath: 'projectId' });
      s.createIndex('updatedAt', 'updatedAt', { unique: false });
    }
  });
}

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {{ name?: string, description?: string }} [opts]
 * @returns {Promise<Project>}
 */
export async function createProject(opts = {}) {
  const now = Date.now();
  /** @type {Project} */
  const project = {
    projectId: newId(),
    name: (opts.name && String(opts.name).trim()) || `Project ${new Date(now).toLocaleString()}`,
    description: opts.description || '',
    createdAt: now,
    updatedAt: now,
    sourceFileIds: [],
    outputs: [],
    savedParams: {},
    activePreset: null,
  };
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  await idbPut(tx.objectStore(STORE), project);
  await idbTxDone(tx);
  return project;
}

/**
 * @returns {Promise<Project[]>}
 */
export async function listProjects() {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    const all = await idbGetAll(tx.objectStore(STORE));
    return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch {
    return [];
  }
}

/**
 * @param {string} projectId
 * @returns {Promise<Project|null>}
 */
export async function getProject(projectId) {
  if (!projectId) return null;
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    return (await idbGet(tx.objectStore(STORE), projectId)) || null;
  } catch {
    return null;
  }
}

/**
 * @param {string} projectId
 * @param {Partial<Project>} patch
 */
export async function updateProject(projectId, patch) {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const existing = await idbGet(store, projectId);
  if (!existing) return null;
  const next = { ...existing, ...patch, projectId, updatedAt: Date.now() };
  await idbPut(store, next);
  await idbTxDone(tx);
  return next;
}

/**
 * @param {string} projectId
 * @param {string} fileId
 */
export async function linkSourceFile(projectId, fileId) {
  const p = await getProject(projectId);
  if (!p) return null;
  const ids = new Set(p.sourceFileIds || []);
  ids.add(fileId);
  return updateProject(projectId, { sourceFileIds: [...ids] });
}

/**
 * @param {string} projectId
 */
export async function deleteProject(projectId) {
  const db = await open();
  const tx = db.transaction(STORE, 'readwrite');
  await idbDelete(tx.objectStore(STORE), projectId);
  await idbTxDone(tx);
}

export default {
  createProject,
  listProjects,
  getProject,
  updateProject,
  linkSourceFile,
  deleteProject,
};
