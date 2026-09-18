/**
 * VoiceIsolate-Pro — On-Device Badge
 * Communicate On-device, Private, Zero Cloud status without marketing clutter
 */

import { Tokens } from '../../tokens/design-tokens.js';

export class OnDeviceBadge {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      status: 'ready', // ready | processing | offline | error
      backend: 'wasm',
      showDetails: false,
      ...options,
    };
    this._initDOM();
  }

  _initDOM() {
    this.container.className = 'vip-ondevice-badge';
    this.container.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: ${Tokens.surface.panel};
      border: 1px solid ${Tokens.border.subtle};
      border-radius: ${Tokens.radius.full};
      font: 500 11px/1 ${Tokens.font.ui};
      color: ${Tokens.text.secondary};
    `;

    this.container.innerHTML = `
      <span data-dot style="width:6px; height:6px; border-radius:50%; background:${Tokens.success.default}; box-shadow:0 0 0 4px ${Tokens.success.wash}, 0 0 10px ${Tokens.success.glow};"></span>
      <span data-label>On-device</span>
      <span data-sep style="width:1px; height:12px; background:${Tokens.border.subtle};"></span>
      <span data-private style="display:inline-flex; align-items:center; gap:4px;">
        <span aria-hidden="true">🔒</span> Private
      </span>
      <span data-sep2 style="width:1px; height:12px; background:${Tokens.border.subtle};"></span>
      <span data-zero>Zero Cloud</span>
      <span data-backend style="margin-left:4px; font:600 9px/1 ${Tokens.font.mono}; padding:2px 6px; background:${Tokens.surface.raised}; border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.full}; color:${Tokens.text.dim};">${this.options.backend}</span>
    `;

    this._els = {
      dot: this.container.querySelector('[data-dot]'),
      label: this.container.querySelector('[data-label]'),
      backend: this.container.querySelector('[data-backend]'),
    };
  }

  setStatus(status, backend = null) {
    this.options.status = status;
    if (backend) this.options.backend = backend;

    const statusMap = {
      ready: { color: Tokens.success.default, label: 'On-device', glow: Tokens.success.glow, wash: Tokens.success.wash },
      processing: { color: Tokens.signal.primary, label: 'Processing locally', glow: 'rgba(46,213,229,0.25)', wash: 'rgba(46,213,229,0.12)' },
      offline: { color: Tokens.text.dim, label: 'Offline ready', glow: 'transparent', wash: 'transparent' },
      error: { color: Tokens.critical.default, label: 'Local error', glow: 'rgba(255,61,77,0.25)', wash: Tokens.critical.wash },
    };
    const cfg = statusMap[status] || statusMap.ready;
    this._els.dot.style.background = cfg.color;
    this._els.dot.style.boxShadow = `0 0 0 4px ${cfg.wash}, 0 0 10px ${cfg.glow}`;
    this._els.label.textContent = cfg.label;
    if (backend) this._els.backend.textContent = backend;
  }

  setBackend(backend) {
    this.options.backend = backend;
    this._els.backend.textContent = backend;
  }

  dispose() {
    this.container.innerHTML = '';
  }
}

export default OnDeviceBadge;
