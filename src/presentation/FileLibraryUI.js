/**
 * Engineer Mode — library list + import mode controls.
 * Pure DOM wiring; persistence via FileLibrary / ProjectStore.
 */
'use strict';

import * as FileLibrary from '../core/FileLibrary.js';
import * as ProjectStore from '../core/ProjectStore.js';
import {
  exportProjectPack,
  importProjectPack,
  downloadPackBlob,
} from '../core/ProjectPack.js';

const IMPORT_MODE_KEY = 'vip-import-mode';

/**
 * @returns {'temporary'|'library'|'project'}
 */
export function getImportMode() {
  try {
    const v = localStorage.getItem(IMPORT_MODE_KEY);
    if (v === 'temporary' || v === 'library' || v === 'project') return v;
  } catch { /* ignore */ }
  return 'library';
}

/**
 * @param {'temporary'|'library'|'project'} mode
 */
export function setImportMode(mode) {
  try {
    localStorage.setItem(IMPORT_MODE_KEY, mode);
  } catch { /* ignore */ }
  const sel = document.getElementById('importModeSelect');
  if (sel && sel.value !== mode) sel.value = mode;
}

/**
 * @param {object} app VoiceIsolatePro instance
 */
export function mountFileLibraryUI(app) {
  if (!app || typeof document === 'undefined') return;
  if (app._fileLibraryMounted) return;
  app._fileLibraryMounted = true;

  const modeSel = document.getElementById('importModeSelect');
  if (modeSel) {
    modeSel.value = getImportMode();
    modeSel.addEventListener('change', () => {
      setImportMode(/** @type {*} */ (modeSel.value));
      const projRow = document.getElementById('projectSelectRow');
      if (projRow) projRow.hidden = modeSel.value !== 'project';
    });
    const projRow = document.getElementById('projectSelectRow');
    if (projRow) projRow.hidden = modeSel.value !== 'project';
  }

  const refreshBtn = document.getElementById('libraryRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => refreshLibraryList(app));
  }

  const newProjBtn = document.getElementById('newProjectBtn');
  if (newProjBtn) {
    newProjBtn.addEventListener('click', async () => {
      const name = window.prompt('Project name', `Project ${new Date().toLocaleDateString()}`);
      if (name == null) return;
      const p = await ProjectStore.createProject({ name: name.trim() || undefined });
      await fillProjectSelect(p.projectId);
      setImportMode('project');
      if (modeSel) modeSel.value = 'project';
      const projRow = document.getElementById('projectSelectRow');
      if (projRow) projRow.hidden = false;
      app.showNotification?.(`Project “${p.name}” created`, 'info');
    });
  }

  const exportBtn = document.getElementById('exportProjectPackBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      const sel = document.getElementById('projectSelect');
      let projectId = sel?.value || null;
      if (!projectId) {
        const projects = await ProjectStore.listProjects();
        projectId = projects[0]?.projectId || null;
      }
      if (!projectId) {
        app.showNotification?.('Create or select a project first', 'warn');
        return;
      }
      try {
        exportBtn.disabled = true;
        const blob = await exportProjectPack(projectId);
        const proj = await ProjectStore.getProject(projectId);
        const safe = (proj?.name || 'project').replace(/[^\w.-]+/g, '_').slice(0, 48);
        downloadPackBlob(blob, `${safe}.vippack`);
        app.showNotification?.('Project pack downloaded — share to another device to import', 'info');
      } catch (err) {
        app.showNotification?.(err.message || 'Export failed', 'error');
      } finally {
        exportBtn.disabled = false;
      }
    });
  }

  const importBtn = document.getElementById('importProjectPackBtn');
  const importInput = document.getElementById('importProjectPackInput');
  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      importInput.value = '';
      if (!file) return;
      try {
        importBtn.disabled = true;
        const result = await importProjectPack(file);
        await fillProjectSelect(result.projectId);
        setImportMode('project');
        if (modeSel) modeSel.value = 'project';
        const projRow = document.getElementById('projectSelectRow');
        if (projRow) projRow.hidden = false;
        await refreshLibraryList(app);
        if (result.fileIds?.[0] && typeof app.openLibraryFile === 'function') {
          await app.openLibraryFile(result.fileIds[0]);
        }
        app.showNotification?.(
          `Imported project (${result.fileIds.length} file${result.fileIds.length === 1 ? '' : 's'})`,
          'info',
        );
      } catch (err) {
        app.showNotification?.(err.message || 'Import failed', 'error');
      } finally {
        importBtn.disabled = false;
      }
    });
  }

  fillProjectSelect().catch(() => {});
  refreshLibraryList(app).catch(() => {});
}

/**
 * @param {string} [selectId]
 */
export async function fillProjectSelect(selectId) {
  const sel = document.getElementById('projectSelect');
  if (!sel) return;
  const projects = await ProjectStore.listProjects();
  const current = selectId || sel.value;
  sel.innerHTML = '<option value="">— Select project —</option>';
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.projectId;
    opt.textContent = p.name;
    sel.appendChild(opt);
  }
  if (current) sel.value = current;
}

/**
 * @param {object} app
 */
export async function refreshLibraryList(app) {
  const list = document.getElementById('fileLibraryList');
  const empty = document.getElementById('fileLibraryEmpty');
  if (!list) return;
  const files = await FileLibrary.listLibraryFiles();
  list.innerHTML = '';
  if (empty) empty.hidden = files.length > 0;

  for (const meta of files) {
    const li = document.createElement('li');
    li.className = 'file-lib-item';
    li.dataset.fileId = meta.id;
    if (app._libraryFileId === meta.id) li.classList.add('is-active');

    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'file-lib-open';
    const sizeMb = meta.size ? (meta.size / (1024 * 1024)).toFixed(1) : '?';
    const dur = meta.duration != null ? `${meta.duration.toFixed(1)}s` : '—';
    title.innerHTML = `<span class="file-lib-name"></span><span class="file-lib-meta"></span>`;
    title.querySelector('.file-lib-name').textContent = meta.originalFilename || meta.id;
    title.querySelector('.file-lib-meta').textContent =
      `${sizeMb} MB · ${dur} · ${meta.processingStatus || 'imported'}`;
    title.addEventListener('click', () => {
      app.openLibraryFile?.(meta.id);
    });

    const actions = document.createElement('div');
    actions.className = 'file-lib-actions';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-outline file-lib-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.title = 'Remove from library (blob kept until permanent delete)';
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.confirm(`Remove “${meta.originalFilename}” from library?`)) return;
      await FileLibrary.removeFromLibrary(meta.id);
      if (app._libraryFileId === meta.id) {
        app._libraryFileId = null;
      }
      await refreshLibraryList(app);
      app.showNotification?.('Removed from library', 'info');
    });

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger file-lib-delete';
    delBtn.textContent = 'Delete';
    delBtn.title = 'Permanently delete file from device storage';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!window.confirm(
        `Permanently delete “${meta.originalFilename}” from this device?\nThis cannot be undone.`,
      )) return;
      await FileLibrary.deleteFilePermanently(meta.id);
      if (app._libraryFileId === meta.id) {
        app._clearFile?.();
        app._libraryFileId = null;
      }
      await refreshLibraryList(app);
      app.showNotification?.('File permanently deleted', 'info');
    });

    actions.append(removeBtn, delBtn);
    li.append(title, actions);
    list.appendChild(li);
  }

  const badge = document.getElementById('libraryCountBadge');
  if (badge) {
    const max = FileLibrary.MAX_LIBRARY_TRACKS || 5;
    badge.textContent = `${files.length}/${max}`;
    badge.title = `Library tracks (max ${max})`;
  }
}

/**
 * Resolve import options from UI.
 * @returns {Promise<{ mode: string, projectId: string|null }>}
 */
export async function readImportOptionsFromUi() {
  const mode = getImportMode();
  let projectId = null;
  if (mode === 'project') {
    const sel = document.getElementById('projectSelect');
    projectId = sel?.value || null;
    if (!projectId) {
      const p = await ProjectStore.createProject({ name: `Project ${new Date().toLocaleString()}` });
      projectId = p.projectId;
      await fillProjectSelect(projectId);
    }
  }
  return { mode, projectId };
}

export default {
  mountFileLibraryUI,
  refreshLibraryList,
  getImportMode,
  setImportMode,
  readImportOptionsFromUi,
  fillProjectSelect,
};
