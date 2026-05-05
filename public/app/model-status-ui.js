/**
 * model-status-ui.js – VoiceIsolate Pro
 *
 * UI component for displaying ML model download status with:
 * - Real-time progress bars
 * - Source indicator (Vercel Blob via same-origin / Browser Cache)
 * - Error notifications with retry options
 * - Cached model status display
 */

import { BROADCAST_CH, getModelStatus } from './model-loader.js';

export class ModelStatusUI {
  constructor(containerId = 'model-status-container') {
    this.container = document.getElementById(containerId);
    if (!this.container) {
      console.warn('[ModelStatusUI] Container not found, creating one');
      this.container = document.createElement('div');
      this.container.id = containerId;
      this.container.className = 'model-status-panel';
      document.body.appendChild(this.container);
    }
    
    this.bc = null;
    this.models = new Map(); // id -> { filename, status, progress, source, error }
    this.isVisible = false;
    
    this._initBroadcastChannel();
    this._render();
  }

  _initBroadcastChannel() {
    try {
      this.bc = new BroadcastChannel(BROADCAST_CH);
      this.bc.onmessage = (ev) => this._handleModelEvent(ev.data);
    } catch (err) {
      console.warn('[ModelStatusUI] BroadcastChannel not available:', err.message);
    }
  }

  _handleModelEvent(data) {
    const { type, id, filename, percent, source, error } = data;

    switch (type) {
      case 'start':
        this.models.set(id, {
          filename,
          status: 'downloading',
          progress: 0,
          source: source || 'vercel',
          error: null,
        });
        this.show();
        break;

      case 'progress':
        if (this.models.has(id)) {
          this.models.get(id).progress = percent || 0;
        }
        break;

      case 'done':
        if (this.models.has(id)) {
          this.models.get(id).status = 'complete';
          this.models.get(id).progress = 100;
        }
        // Auto-hide after a brief delay if all models are complete
        setTimeout(() => this._checkAutoHide(), 3000);
        break;

      case 'cached':
        this.models.set(id, {
          filename,
          status: 'cached',
          progress: 100,
          source: 'cache',
          error: null,
        });
        break;

      case 'error':
        this.models.set(id, {
          filename,
          status: 'error',
          progress: 0,
          source: source || 'vercel',
          error: error || 'Download failed',
        });
        this.show();
        break;
    }

    this._render();
  }

  _checkAutoHide() {
    const allComplete = Array.from(this.models.values()).every(
      m => m.status === 'complete' || m.status === 'cached'
    );
    if (allComplete && this.models.size > 0) {
      setTimeout(() => this.hide(), 2000);
    }
  }

  async refreshStatus() {
    const status = await getModelStatus();
    status.forEach(model => {
      if (model.cached && !this.models.has(model.id)) {
        this.models.set(model.id, {
          filename: model.filename,
          status: 'cached',
          progress: 100,
          source: 'cache',
          error: null,
        });
      }
    });
    this._render();
  }

  show() {
    this.isVisible = true;
    this.container.classList.add('visible');
  }

  hide() {
    this.isVisible = false;
    this.container.classList.remove('visible');
  }

  toggle() {
    if (this.isVisible) this.hide();
    else this.show();
  }

  _render() {
    if (this.models.size === 0) {
      this.container.innerHTML = `
        <div class="model-status-empty">
          <p>No models loaded yet</p>
          <button onclick="window.modelStatusUI?.refreshStatus()">Check Status</button>
        </div>
      `;
      return;
    }

    const html = `
      <div class="model-status-header">
        <h3>ML Model Status</h3>
        <button class="close-btn" onclick="window.modelStatusUI?.hide()">×</button>
      </div>
      <div class="model-status-list">
        ${Array.from(this.models.entries()).map(([id, model]) => this._renderModel(id, model)).join('')}
      </div>
      <div class="model-status-footer">
        <button onclick="window.modelStatusUI?.refreshStatus()">Refresh</button>
        <button onclick="window.modelStatusUI?.hide()">Close</button>
      </div>
    `;
    
    this.container.innerHTML = html;
  }

  _renderModel(id, model) {
    const { filename, status, progress, source, error } = model;

    const statusIcon = {
      downloading: '⬇️',
      complete:    '✅',
      cached:      '💾',
      error:       '❌',
    }[status] || '⏳';

    const sourceLabel = {
      vercel: 'Vercel Blob',
      cache:  'Browser Cache',
    }[source] || source;

    const statusClass = status === 'error' ? 'error'
                      : status === 'downloading' ? 'active'
                      : 'complete';

    return `
      <div class="model-item ${statusClass}">
        <div class="model-header">
          <span class="model-icon">${statusIcon}</span>
          <span class="model-name">${filename}</span>
          <span class="model-source">${sourceLabel}</span>
        </div>
        ${status === 'downloading' ? `
          <div class="model-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${progress}%"></div>
            </div>
            <span class="progress-text">${progress}%</span>
          </div>
        ` : ''}
        ${status === 'error' ? `
          <div class="model-error">
            <p class="error-message">${error}</p>
            <button onclick="window.location.reload()">Retry</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  destroy() {
    this.bc?.close();
    this.container.remove();
  }
}

// Auto-initialize if container exists
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('model-status-container')) {
      window.modelStatusUI = new ModelStatusUI();
      window.modelStatusUI.refreshStatus();
    }
  });
}

// Made with Bob
