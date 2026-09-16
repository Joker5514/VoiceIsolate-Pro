import { QUICK_CLEAN_OUTCOMES, resolveQuickCleanPlan } from '../pipeline/QuickCleanPlan.js';

const STATES = new Set(['empty', 'importing', 'imported', 'ready', 'downloading',
  'processing', 'cancelling', 'processed', 'comparing', 'exporting', 'exported', 'error']);

/** Small presentation adapter; the existing Landing controller owns jobs and stems. */
export class QuickCleanUI {
  constructor(doc = document) {
    this.doc = doc;
    this.backend = 'probing';
    this.state = 'empty';
    this.select = doc.getElementById('modelSelect');
    this.select.replaceChildren(...QUICK_CLEAN_OUTCOMES.map((outcome) => {
      const option = doc.createElement('option');
      option.value = outcome.id;
      option.textContent = outcome.label;
      option.disabled = true;
      return option;
    }));
    this.select.value = 'bsrnn_vocals';
  }

  setBackend(backend) {
    this.backend = backend;
    for (const option of this.select.options) {
      try { resolveQuickCleanPlan(option.value, { backend }); option.disabled = false; }
      catch { option.disabled = true; }
    }
  }

  plan() { return resolveQuickCleanPlan(this.select.value, { backend: this.backend }); }

  /**
   * Publish the current Quick Clean stage.
   *
   * An unknown state is still a programming error and throws. Missing DOM
   * nodes are not: this is a presentation adapter, and a host page that omits
   * an optional node must never be able to abort ingestion or processing.
   */
  setState(state, message) {
    if (!STATES.has(state)) throw new Error(`Unknown Quick Clean state: ${state}`);
    this.state = state;
    const panel = this.doc.getElementById('uploadPanel');
    if (panel) panel.dataset.state = state;
    const status = this.doc.getElementById('quickCleanStatus');
    if (status) {
      status.textContent = message;
      status.dataset.state = state;
    }
  }

  /** @param {string} id @param {string} text */
  _write(id, text) {
    const el = this.doc.getElementById(id);
    if (el) el.textContent = text;
  }

  preflight(device, source) {
    const outcome = QUICK_CLEAN_OUTCOMES.find((item) => item.id === this.select.value);
    this._write('outcomeHelp', outcome?.description || 'Choose an available outcome.');
    try {
      const plan = this.plan();
      const mb = (plan.downloadBytes / 1048576).toFixed(1);
      const storage = device?.freeBytes == null ? 'Available storage could not be measured.'
        : device.freeBytes < plan.downloadBytes
          ? 'Storage is low: model caching may fail. Clear local data if needed; processing can run without saving the cache.'
          : `${Math.floor(device.freeBytes / 1048576)} MB storage available; decoded audio also needs memory.`;
      this._write('quickCleanPreflight', `${this.backend === 'webgpu' ? 'WebGPU' : 'WASM'} available for local processing. `
        + (device?.online === false
          ? `Offline: Process requires previously cached models (${mb} MB). Reconnect if loading fails. `
          : `Up to ${mb} MB of models download when you press Process; cached bytes are checked before use. `)
        + storage + (source ? ` Recording: ${source.duration.toFixed(1)} seconds at 48 kHz.` : ''));
      this._write('quickCleanModelDetails', `${plan.modelIds.join(' → ')} · SHA-256 verified · 48 kHz`);
      return true;
    } catch (err) {
      this._write('quickCleanPreflight', err.message);
      return false;
    }
  }
}
