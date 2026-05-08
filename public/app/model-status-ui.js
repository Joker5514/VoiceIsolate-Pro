// model-status-ui.js — VoiceIsolate Pro
// Displays per-model cache/load status pills in the UI.

const STATUS_CONFIG = {
  cached:  { label: '✓ Cached',              cls: 'vip-pill--green'  },
  loading: { label: '⟳ Loading…',            cls: 'vip-pill--amber'  },
  pending: { label: 'Lazy — loads on first drop', cls: 'vip-pill--grey' },
  error:   { label: '✗ Not found',           cls: 'vip-pill--red'    },
  unknown: { label: '? Unknown',             cls: 'vip-pill--grey'   },
};

export class ModelStatusUI {
  /**
   * @param {HTMLElement} container  – element to render pills into
   * @param {string[]}    modelKeys  – e.g. ['demucs','bsrnn','rnnoise','nsnet2','silero_vad']
   */
  constructor(container, modelKeys = []) {
    this._container = container;
    this._keys = modelKeys;
    this._pills = {};
    this._pollingTimer = null;
    this._loadingCount = 0;
    this._render();
  }

  _render() {
    if (!this._container) return;
    this._container.innerHTML = '';
    for (const key of this._keys) {
      const pill = document.createElement('span');
      pill.className = 'vip-pill vip-pill--grey';
      pill.dataset.model = key;
      pill.textContent = key;
      this._container.appendChild(pill);
      this._pills[key] = pill;
    }
  }

  /**
   * Update a single model's pill status.
   * @param {string} key     – model key
   * @param {'cached'|'loading'|'pending'|'error'} status
   * @param {number} [pct]   – progress percentage for 'loading' state
   */
  setStatus(key, status, pct) {
    const pill = this._pills[key];
    if (!pill) return;

    const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
    // Remove all status classes
    pill.className = `vip-pill ${cfg.cls}`;

    if (status === 'loading' && pct !== undefined) {
      pill.textContent = `⟳ Loading ${Math.round(pct)}%`;
    } else {
      pill.textContent = cfg.label;
    }

    // Track loading models for auto-polling stop
    if (status === 'loading') {
      this._loadingCount++;
      this._startPolling();
    } else if (this._loadingCount > 0) {
      this._loadingCount = Math.max(0, this._loadingCount - 1);
      if (this._loadingCount === 0) this._stopPolling();
    }
  }

  /**
   * Refresh all model statuses by reading from Cache API and manifest.
   */
  async refreshStatus() {
    let manifest = {};
    try {
      const res = await fetch('/app/models-manifest.json', { cache: 'no-cache' });
      if (res.ok) manifest = await res.json();
    } catch { /* ignore */ }

    let hasLoading = false;
    for (const key of this._keys) {
      const cacheKey = `/app/models/${key}.onnx`;
      try {
        const cache = await caches.open('vip-models-v1');
        const match = await cache.match(cacheKey);
        if (match) {
          this.setStatus(key, 'cached');
        } else if (manifest[key]) {
          this.setStatus(key, 'loading');
          hasLoading = true;
        } else {
          this.setStatus(key, 'pending');
        }
      } catch {
        this.setStatus(key, 'error');
      }
    }

    if (!hasLoading) this._stopPolling();
  }

  _startPolling() {
    if (this._pollingTimer) return;
    this._pollingTimer = setInterval(() => this.refreshStatus(), 5000);
  }

  _stopPolling() {
    if (this._pollingTimer) {
      clearInterval(this._pollingTimer);
      this._pollingTimer = null;
    }
  }

  destroy() {
    this._stopPolling();
  }
}
