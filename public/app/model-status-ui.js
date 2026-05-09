// model-status-ui.js — VoiceIsolate Pro
// Displays per-model cache/load status pills in the UI plus active-provider badges.
// Also renders a "CDN Health" panel populated by window.ModelCDNLoader.getProviderHealthReport().

const STATUS_CONFIG = {
  cached:  { label: '✓ Cached',                    cls: 'vip-pill--green' },
  loading: { label: '⟳ Loading…',                  cls: 'vip-pill--amber' },
  pending: { label: 'Lazy — loads on first drop',  cls: 'vip-pill--grey'  },
  error:   { label: '✗ All failed',                cls: 'vip-pill--red'   },
  unknown: { label: '? Unknown',                   cls: 'vip-pill--grey'  },
};

const PROVIDER_BADGE = {
  'vercel-blob': { label: '✓ Vercel Blob',    cls: 'vip-provider--green'  },
  'r2':          { label: '✓ Cloudflare R2',  cls: 'vip-provider--blue'   },
  'huggingface': { label: '✓ HuggingFace',    cls: 'vip-provider--yellow' },
  'cache':       { label: '✓ SW Cache',       cls: 'vip-provider--grey'   },
};

const HEALTH_LABELS = {
  'vercel-blob': 'Vercel Blob',
  'r2':          'Cloudflare R2',
  'huggingface': 'HuggingFace',
};

export class ModelStatusUI {
  /**
   * @param {HTMLElement} container  – element to render pills into
   * @param {string[]}    modelKeys  – e.g. ['demucs','bsrnn','rnnoise','nsnet2','silero_vad']
   * @param {object}      [opts]
   * @param {HTMLElement} [opts.healthContainer] – element to render CDN health rows into
   */
  constructor(container, modelKeys = [], opts = {}) {
    this._container = container;
    this._healthContainer = opts.healthContainer || null;
    this._keys = modelKeys;
    this._pills = {};
    this._badges = {};
    this._healthRows = {};
    this._pollingTimer = null;
    this._healthTimer = null;
    this._loadingCount = 0;
    this._render();
    this._renderHealth();
    this._startHealthPolling();
  }

  _render() {
    if (!this._container) return;
    this._container.innerHTML = '';
    for (const key of this._keys) {
      const wrap = document.createElement('span');
      wrap.className = 'vip-pill-wrap';
      wrap.dataset.model = key;

      const pill = document.createElement('span');
      pill.className = 'vip-pill vip-pill--grey';
      pill.dataset.model = key;
      pill.textContent = key;

      const badge = document.createElement('span');
      badge.className = 'vip-provider vip-provider--hidden';
      badge.dataset.model = key;
      badge.textContent = '';

      wrap.appendChild(pill);
      wrap.appendChild(badge);
      this._container.appendChild(wrap);
      this._pills[key] = pill;
      this._badges[key] = badge;
    }
  }

  _renderHealth() {
    if (!this._healthContainer) return;
    this._healthContainer.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'vip-cdn-health-title';
    title.textContent = 'CDN Health';
    this._healthContainer.appendChild(title);

    for (const provider of Object.keys(HEALTH_LABELS)) {
      const row = document.createElement('div');
      row.className = 'vip-cdn-health-row';
      row.dataset.provider = provider;

      const label = document.createElement('span');
      label.className = 'vip-cdn-health-label';
      label.textContent = HEALTH_LABELS[provider];

      const status = document.createElement('span');
      status.className = 'vip-cdn-health-status vip-cdn-health-status--unknown';
      status.textContent = 'unknown';

      row.appendChild(label);
      row.appendChild(status);
      this._healthContainer.appendChild(row);
      this._healthRows[provider] = status;
    }
    this.refreshHealth();
  }

  /**
   * Update a single model's pill status.
   * @param {string} key      – model key
   * @param {'cached'|'loading'|'pending'|'error'} status
   * @param {number} [pct]    – progress percentage for 'loading' state
   * @param {string} [provider] – which CDN served the model (vercel-blob | r2 | huggingface)
   */
  setStatus(key, status, pct, provider) {
    const pill = this._pills[key];
    if (!pill) return;

    const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.unknown;
    pill.className = `vip-pill ${cfg.cls}`;

    if (status === 'loading' && pct !== undefined) {
      pill.textContent = `⟳ ${key} ${Math.round(pct)}%`;
    } else {
      pill.textContent = `${key} ${cfg.label}`;
    }

    // Update provider badge
    const badge = this._badges[key];
    if (badge) {
      const resolvedProvider = provider
        || (window.ModelCDNLoader && window.ModelCDNLoader.getModelProvider
            ? window.ModelCDNLoader.getModelProvider(key) : null);
      if (status === 'cached' && resolvedProvider && PROVIDER_BADGE[resolvedProvider]) {
        const pcfg = PROVIDER_BADGE[resolvedProvider];
        badge.className = `vip-provider ${pcfg.cls}`;
        badge.textContent = pcfg.label;
      } else if (status === 'error') {
        badge.className = 'vip-provider vip-provider--red';
        badge.textContent = '✗ All failed';
      } else {
        badge.className = 'vip-provider vip-provider--hidden';
        badge.textContent = '';
      }
    }

    // Track loading models for auto-polling stop
    if (status === 'loading') {
      this._loadingCount++;
      this._startPolling();
    } else if (this._loadingCount > 0) {
      this._loadingCount = Math.max(0, this._loadingCount - 1);
      if (this._loadingCount === 0) this._stopPolling();
    }

    // Refresh CDN health alongside model state changes
    this.refreshHealth();
  }

  /**
   * Refresh all model statuses by reading from Cache API and manifest.
   */
  async refreshStatus() {
    let manifest = null;
    if (window.ModelCDNLoader && window.ModelCDNLoader.getManifest) {
      try { manifest = await window.ModelCDNLoader.getManifest(); }
      catch { /* ignore */ }
    }

    let hasLoading = false;
    for (const key of this._keys) {
      try {
        const cache = await caches.open('vip-models-v1');
        const match = await cache.match(`/vip-model-cache/${key}`);
        if (match) {
          const provider = match.headers.get('X-VIP-Provider') || 'cache';
          this.setStatus(key, 'cached', undefined, provider);
        } else if (manifest && manifest.models && manifest.models[key]) {
          if (manifest.models[key].eager) {
            this.setStatus(key, 'loading');
            hasLoading = true;
          } else {
            this.setStatus(key, 'pending');
          }
        } else {
          this.setStatus(key, 'pending');
        }
      } catch {
        this.setStatus(key, 'error');
      }
    }

    if (!hasLoading) this._stopPolling();
  }

  /**
   * refreshHealth — pull current provider health from window.ModelCDNLoader and update rows.
   */
  refreshHealth() {
    if (!this._healthContainer) return;
    if (!window.ModelCDNLoader || !window.ModelCDNLoader.getProviderHealthReport) return;
    const report = window.ModelCDNLoader.getProviderHealthReport();
    for (const provider of Object.keys(this._healthRows)) {
      const el = this._healthRows[provider];
      const healthy = report[provider];
      el.classList.remove('vip-cdn-health-status--healthy', 'vip-cdn-health-status--degraded', 'vip-cdn-health-status--unknown');
      if (healthy === true) {
        el.classList.add('vip-cdn-health-status--healthy');
        el.textContent = 'healthy';
      } else if (healthy === false) {
        el.classList.add('vip-cdn-health-status--degraded');
        el.textContent = 'degraded';
      } else {
        el.classList.add('vip-cdn-health-status--unknown');
        el.textContent = 'unknown';
      }
    }
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

  _startHealthPolling() {
    if (this._healthTimer || !this._healthContainer) return;
    this._healthTimer = setInterval(() => this.refreshHealth(), 10000);
  }

  destroy() {
    this._stopPolling();
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
  }
}
