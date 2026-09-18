/**
 * VoiceIsolate-Pro — Contextual Action Palette
 * Shows after selection: Isolate, Enhance Voice, Reduce Noise, Boost Whisper, Preview, More…
 * Desktop: adjacent to selection. Mobile: bottom sheet
 */

import { getUIStore } from '../../../state/uiStore.js';

export const Actions = Object.freeze({
  ISOLATE: 'isolate',
  ENHANCE_VOICE: 'enhance_voice',
  REDUCE_NOISE: 'reduce_noise',
  BOOST_WHISPER: 'boost_whisper',
  PREVIEW: 'preview',
  ZOOM: 'zoom',
  CLEAR: 'clear',
  EXPORT_SELECTION: 'export_selection',
  MORE: 'more',
});

const ActionLabels = Object.freeze({
  [Actions.ISOLATE]: 'Isolate',
  [Actions.ENHANCE_VOICE]: 'Enhance Voice',
  [Actions.REDUCE_NOISE]: 'Reduce Noise',
  [Actions.BOOST_WHISPER]: 'Boost Whisper',
  [Actions.PREVIEW]: 'Preview',
  [Actions.ZOOM]: 'Zoom to Selection',
  [Actions.CLEAR]: 'Clear',
  [Actions.EXPORT_SELECTION]: 'Export Selection',
  [Actions.MORE]: 'More…',
});

const ActionIcons = Object.freeze({
  [Actions.ISOLATE]: '◉',
  [Actions.ENHANCE_VOICE]: '♪',
  [Actions.REDUCE_NOISE]: '◍',
  [Actions.BOOST_WHISPER]: '✧',
  [Actions.PREVIEW]: '▶',
  [Actions.ZOOM]: '⛶',
  [Actions.CLEAR]: '✕',
  [Actions.EXPORT_SELECTION]: '⤓',
  [Actions.MORE]: '…',
});

export class RegionActionPalette {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      actions: [
        Actions.ISOLATE,
        Actions.ENHANCE_VOICE,
        Actions.REDUCE_NOISE,
        Actions.BOOST_WHISPER,
        Actions.PREVIEW,
        Actions.MORE,
      ],
      ...options,
    };
    this._selection = null;
    this._listeners = new Map();
    this._paletteEl = null;
    this._bottomSheetEl = null;
    this._isMobile = false;

    this._detectMobile();
    this._initDOM();
  }

  _detectMobile() {
    try {
      const uiStore = getUIStore();
      this._isMobile = uiStore.isMobileLayout() || uiStore.isTouchDevice();
    } catch {
      this._isMobile = window.innerWidth < 768 || 'ontouchstart' in window;
    }
  }

  _initDOM() {
    // Desktop palette: floating near selection
    this._paletteEl = document.createElement('div');
    this._paletteEl.className = 'vip-action-palette';
    this._paletteEl.setAttribute('role', 'toolbar');
    this._paletteEl.setAttribute('aria-label', 'Region actions');
    this._paletteEl.style.cssText = `
      position: absolute;
      z-index: 20;
      display: none;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px;
      background: rgba(13,19,27,0.96);
      border: 1px solid #1d2a34;
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 0 0 1px rgba(155,108,255,0.12);
      backdrop-filter: blur(16px);
      max-width: 320px;
    `;

    // Bottom sheet for mobile
    this._bottomSheetEl = document.createElement('div');
    this._bottomSheetEl.className = 'vip-action-bottom-sheet';
    this._bottomSheetEl.setAttribute('role', 'dialog');
    this._bottomSheetEl.setAttribute('aria-label', 'Selection actions');
    this._bottomSheetEl.style.cssText = `
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 100;
      display: none;
      flex-direction: column;
      gap: 8px;
      padding: 16px;
      padding-bottom: max(16px, env(safe-area-inset-bottom));
      background: #0d131b;
      border-top: 1px solid #1d2a34;
      border-radius: 14px 14px 0 0;
      box-shadow: 0 -8px 32px rgba(0,0,0,0.6);
      transform: translateY(100%);
      transition: transform 0.32s cubic-bezier(0.22, 0.7, 0.2, 1);
    `;

    // Close on outside click for desktop
    document.addEventListener('click', (e) => {
      if (this._paletteEl.style.display === 'none') return;
      if (this._paletteEl.contains(e.target)) return;
      if (this.container.contains(e.target) && e.target.closest('.vip-region-bounds')) return;
      // Don't auto-close if clicking inside palette
      // For now, keep open until selection cleared or action taken
    });

    document.body.appendChild(this._bottomSheetEl);
    this.container.appendChild(this._paletteEl);
  }

  _renderActions() {
    const actions = this.options.actions;
    const fragDesktop = document.createDocumentFragment();
    const fragMobile = document.createDocumentFragment();

    // Mobile header
    const header = document.createElement('div');
    header.style.cssText = `display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;`;
    header.innerHTML = `
      <span style="font:600 12px/1 ui-sans-serif; color:#f4f7fa;">Selection Action</span>
      <button data-action="close" style="width:32px; height:32px; border-radius:50%; border:1px solid #1d2a34; background:transparent; color:#8d9aaa; cursor:pointer;">✕</button>
    `;
    fragMobile.appendChild(header);

    for (const action of actions) {
      const label = ActionLabels[action] || action;
      const icon = ActionIcons[action] || '•';

      // Desktop button
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.action = action;
      btn.className = 'vip-action-btn';
      btn.setAttribute('aria-label', label);
      btn.style.cssText = `
        display: inline-flex;
        align-items: center;
        gap: 6px;
        min-height: 36px;
        padding: 6px 12px;
        font: 500 12px/1 ui-sans-serif;
        color: #c5ced6;
        background: ${action === Actions.ISOLATE ? '#9b6cff' : '#121a23'};
        border: 1px solid ${action === Actions.ISOLATE ? '#9b6cff' : '#26323d'};
        border-radius: 6px;
        cursor: pointer;
        white-space: nowrap;
        transition: all 0.12s ease;
      `;
      if (action === Actions.ISOLATE) {
        btn.style.color = 'white';
        btn.style.fontWeight = '600';
      }
      btn.innerHTML = `<span aria-hidden="true">${icon}</span> ${label}`;
      btn.addEventListener('click', () => this._handleAction(action));
      btn.addEventListener('mouseenter', () => {
        btn.style.borderColor = '#9b6cff';
        btn.style.color = '#f4f7fa';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.borderColor = action === Actions.ISOLATE ? '#9b6cff' : '#26323d';
        btn.style.color = action === Actions.ISOLATE ? 'white' : '#c5ced6';
      });
      fragDesktop.appendChild(btn);

      // Mobile button
      const mBtn = document.createElement('button');
      mBtn.type = 'button';
      mBtn.dataset.action = action;
      mBtn.style.cssText = `
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        min-height: 48px;
        padding: 12px 16px;
        font: 500 14px/1 ui-sans-serif;
        color: #f4f7fa;
        background: ${action === Actions.ISOLATE ? '#9b6cff' : '#121a23'};
        border: 1px solid ${action === Actions.ISOLATE ? '#9b6cff' : '#1d2a34'};
        border-radius: 10px;
        cursor: pointer;
        text-align: left;
      `;
      mBtn.innerHTML = `<span style="width:28px; height:28px; display:grid; place-items:center; border-radius:6px; background:rgba(255,255,255,0.08);">${icon}</span> ${label}`;
      mBtn.addEventListener('click', () => this._handleAction(action));
      fragMobile.appendChild(mBtn);
    }

    // Clear and append
    this._paletteEl.replaceChildren(fragDesktop);
    // Keep header + actions
    const existingHeader = this._bottomSheetEl.querySelector('div');
    this._bottomSheetEl.replaceChildren(header, fragMobile);

    // Bind close
    this._bottomSheetEl.querySelector('[data-action="close"]')?.addEventListener('click', () => this.hide());
  }

  _handleAction(action) {
    if (action === Actions.MORE) {
      this._emit('more', { selection: this._selection });
      return;
    }
    if (action === 'close') {
      this.hide();
      return;
    }
    this._emit('action', { action, selection: this._selection });
    // Don't auto-hide for preview/zoom, hide for others optionally
    if ([Actions.ISOLATE, Actions.CLEAR].includes(action)) {
      // Keep visible for feedback, but could hide after
    }
  }

  show(selection, anchorRect = null) {
    this._selection = selection;
    if (!selection) {
      this.hide();
      return;
    }
    this._renderActions();
    this._detectMobile();

    if (this._isMobile) {
      this._bottomSheetEl.style.display = 'flex';
      // Trigger animation
      requestAnimationFrame(() => {
        this._bottomSheetEl.style.transform = 'translateY(0)';
      });
      // Haptic feedback if available
      try {
        if (navigator.vibrate) navigator.vibrate(20);
      } catch {}
    } else {
      this._paletteEl.style.display = 'flex';
      // Position near selection
      if (anchorRect) {
        const containerRect = this.container.getBoundingClientRect();
        let left = anchorRect.left - containerRect.left;
        let top = anchorRect.bottom - containerRect.top + 8;
        // Keep inside container
        const paletteWidth = 320;
        if (left + paletteWidth > containerRect.width) {
          left = containerRect.width - paletteWidth - 8;
        }
        if (top + 80 > containerRect.height) {
          top = anchorRect.top - containerRect.top - 50;
        }
        this._paletteEl.style.left = `${Math.max(8, left)}px`;
        this._paletteEl.style.top = `${Math.max(8, top)}px`;
      } else {
        this._paletteEl.style.left = '8px';
        this._paletteEl.style.top = '8px';
      }
    }

    this._emit('shown', selection);
  }

  hide() {
    this._paletteEl.style.display = 'none';
    this._bottomSheetEl.style.transform = 'translateY(100%)';
    setTimeout(() => {
      if (this._bottomSheetEl.style.transform.includes('100%')) {
        this._bottomSheetEl.style.display = 'none';
      }
    }, 320);
    this._emit('hidden', null);
  }

  setActions(actions) {
    this.options.actions = actions;
    if (this._selection) this._renderActions();
  }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of set) {
        try { fn(payload); } catch {}
      }
    }
  }

  dispose() {
    this._paletteEl?.remove();
    this._bottomSheetEl?.remove();
  }
}

export default RegionActionPalette;
