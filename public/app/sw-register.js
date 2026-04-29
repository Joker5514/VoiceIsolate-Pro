// ─────────────────────────────────────────────────────────────────────────────
// sw-register.js — VoiceIsolate Pro
// Registers the service worker and wires the model progress UI.
// Import this as the FIRST <script type="module"> in index.html.
// ─────────────────────────────────────────────────────────────────────────────

import { loadEagerModels, BROADCAST_CH } from './model-loader.js';

/**
 * Register the service worker.
 * Resolves when the SW is controlling the page (existing or new activation).
 */
export async function registerSW() {
  if (!('serviceWorker' in navigator)) {
    console.warn('[sw-register] Service workers not supported — model caching unavailable');
    return null;
  }

  try {
    const reg = await navigator.serviceWorker.register('/app/sw.js', {
      scope: '/app/',
      // Update the SW in the background without breaking the current session.
      updateViaCache: 'none',
    });
    console.info('[sw-register] SW registered, scope:', reg.scope);

    // If a SW is already controlling, we're done immediately.
    if (navigator.serviceWorker.controller) return reg;

    // Wait for the new SW to take control so model fetches are intercepted.
    await new Promise((resolve) => {
      const ctrl = navigator.serviceWorker;
      if (ctrl.controller) { resolve(); return; }
      ctrl.addEventListener('controllerchange', resolve, { once: true });
    });

    return reg;
  } catch (err) {
    console.error('[sw-register] SW registration failed:', err.message);
    return null;
  }
}

/**
 * initModelLoader(opts)
 * Call once per page load after registerSW().
 * Starts eager model download (first run) or confirms cache hit (repeat visits).
 *
 * @param {object} opts
 * @param {HTMLElement|null} opts.progressBar    — <progress> or custom element with .value / .max
 * @param {HTMLElement|null} opts.statusEl       — element whose textContent is updated
 * @param {(detail: object) => void} opts.onProgress  — optional raw progress callback
 */
export async function initModelLoader({
  progressBar  = null,
  statusEl     = null,
  onProgress   = null,
} = {}) {

  // Listen to BroadcastChannel for progress events from model-loader.
  let bc = null;
  try {
    bc = new BroadcastChannel(BROADCAST_CH);
    bc.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;

      if (typeof onProgress === 'function') onProgress(d);

      switch (d.type) {
        case 'start':
          if (statusEl) statusEl.textContent = `Downloading ${d.filename} (${d.sizeMB} MB)…`;
          if (progressBar) { progressBar.value = 0; progressBar.max = 100; progressBar.style.display = 'block'; }
          break;

        case 'progress':
          if (progressBar) progressBar.value = d.percent;
          if (statusEl) statusEl.textContent = `${d.filename}: ${d.percent}%`;
          break;

        case 'done':
          if (statusEl) statusEl.textContent = `${d.filename} ready ✓`;
          if (progressBar) { progressBar.value = 100; }
          break;

        case 'cached':
          if (statusEl) statusEl.textContent = `${d.filename} cached ✓`;
          break;

        case 'error':
          console.error('[sw-register] Model load error:', d.filename, d.error);
          if (statusEl) statusEl.textContent = `⚠ ${d.filename} failed — using classical DSP`;
          break;
      }
    };
  } catch { /* BroadcastChannel unavailable (e.g. private browsing on some browsers) */ }

  const result = await loadEagerModels();

  if (progressBar) progressBar.style.display = 'none';
  if (statusEl && result.failed.length === 0) {
    statusEl.textContent = 'Models ready';
  }

  bc?.close();
  return result;
}
