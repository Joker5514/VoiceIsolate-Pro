/**
 * VoiceIsolate-Pro — Comparison Toggle
 * Raw / Processed / Removed (Delta) — first-class trust feature
 * Raw is immutable, Removed lets audition what was removed
 */

import { ComparisonModes } from '../../tokens/design-tokens.js';
import { Tokens } from '../../tokens/design-tokens.js';

export class ComparisonToggle {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      mode: ComparisonModes.PROCESSED,
      ...options,
    };
    this._listeners = new Map();
    this._initDOM();
  }

  _initDOM() {
    this.container.className = 'vip-comparison-toggle';
    this.container.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 12px;
      background: ${Tokens.surface.panel};
      border: 1px solid ${Tokens.border.subtle};
      border-radius: ${Tokens.radius.lg};
    `;

    this.container.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between;">
        <span style="font:600 11px/1 ${Tokens.font.mono}; letter-spacing:0.08em; text-transform:uppercase; color:${Tokens.text.dim};">Compare</span>
        <span data-hint style="font:500 10px/1 ${Tokens.font.ui}; color:${Tokens.text.ghost};">Raw immutable</span>
      </div>
      <div role="group" aria-label="Comparison mode" style="display:inline-flex; border:1px solid ${Tokens.border.strong}; border-radius:${Tokens.radius.md}; overflow:hidden; background:${Tokens.surface.raised};">
        <button data-mode="raw" aria-pressed="false" style="flex:1; min-height:36px; padding:6px 12px; font:600 11px/1 ${Tokens.font.ui}; background:transparent; border:0; border-right:1px solid ${Tokens.border.strong}; color:${Tokens.text.secondary}; cursor:pointer;">
          <span style="display:block; font-size:14px;">●</span> Raw
        </button>
        <button data-mode="processed" aria-pressed="true" style="flex:1; min-height:36px; padding:6px 12px; font:600 11px/1 ${Tokens.font.ui}; background:${Tokens.signal.primary}22; border:0; border-right:1px solid ${Tokens.border.strong}; color:${Tokens.text.primary}; cursor:pointer; box-shadow:inset 0 -2px 0 ${Tokens.signal.primary};">
          <span style="display:block; font-size:14px;">◉</span> Processed
        </button>
        <button data-mode="removed" aria-pressed="false" style="flex:1; min-height:36px; padding:6px 12px; font:600 11px/1 ${Tokens.font.ui}; background:transparent; border:0; color:${Tokens.text.secondary}; cursor:pointer;">
          <span style="display:block; font-size:14px;">◍</span> Removed
        </button>
      </div>
      <div data-desc style="font:400 11px/1.4 ${Tokens.font.ui}; color:${Tokens.text.secondary};">
        Processed: cleaned voice. Removed lets you audition what was removed to detect accidental speech destruction.
      </div>
      <div style="display:flex; gap:6px;">
        <button data-action="ab" style="flex:1; min-height:32px; padding:6px 10px; font:600 11px/1 ${Tokens.font.ui}; background:${Tokens.surface.raised}; border:1px solid ${Tokens.border.strong}; border-radius:${Tokens.radius.md}; color:${Tokens.text.primary}; cursor:pointer;">A/B Switch (X)</button>
        <button data-action="previewRemoved" style="flex:1; min-height:32px; padding:6px 10px; font:500 11px/1 ${Tokens.font.ui}; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.md}; color:${Tokens.text.secondary}; cursor:pointer;">Preview Removed</button>
      </div>
    `;

    this._els = {
      raw: this.container.querySelector('[data-mode="raw"]'),
      processed: this.container.querySelector('[data-mode="processed"]'),
      removed: this.container.querySelector('[data-mode="removed"]'),
      desc: this.container.querySelector('[data-desc]'),
      ab: this.container.querySelector('[data-action="ab"]'),
      previewRemoved: this.container.querySelector('[data-action="previewRemoved"]'),
    };

    this._els.raw.addEventListener('click', () => this.setMode(ComparisonModes.RAW));
    this._els.processed.addEventListener('click', () => this.setMode(ComparisonModes.PROCESSED));
    this._els.removed.addEventListener('click', () => this.setMode(ComparisonModes.REMOVED));
    this._els.ab.addEventListener('click', () => this._emit('abToggle'));
    this._els.previewRemoved.addEventListener('click', () => {
      this.setMode(ComparisonModes.REMOVED);
      this._emit('previewRemoved');
    });

    // Keyboard A/B
    this.container.addEventListener('keydown', (e) => {
      if (e.key.toLowerCase() === 'x') {
        e.preventDefault();
        this._emit('abToggle');
      }
    });
    if (!this.container.hasAttribute('tabindex')) this.container.setAttribute('tabindex', '0');
  }

  setMode(mode) {
    if (!Object.values(ComparisonModes).includes(mode)) return;
    this.options.mode = mode;

    // Update UI
    for (const [key, el] of Object.entries(this._els)) {
      if (!['raw', 'processed', 'removed'].includes(key)) continue;
      const isActive = key === mode;
      el.setAttribute('aria-pressed', String(isActive));
      el.style.background = isActive ? `${Tokens.signal.primary}22` : 'transparent';
      el.style.color = isActive ? Tokens.text.primary : Tokens.text.secondary;
      el.style.boxShadow = isActive ? `inset 0 -2px 0 ${Tokens.signal.primary}` : 'none';
    }

    const descs = {
      [ComparisonModes.RAW]: 'Raw: original immutable source. Never overwritten.',
      [ComparisonModes.PROCESSED]: 'Processed: cleaned voice. Adjust with Enhance controls.',
      [ComparisonModes.REMOVED]: 'Removed (Delta): what processing removed. Audition to detect accidental speech destruction.',
    };
    this._els.desc.textContent = descs[mode] || descs.processed;

    this._emit('modeChanged', mode);
  }

  getMode() { return this.options.mode; }

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
    this.container.innerHTML = '';
  }
}

export default ComparisonToggle;
