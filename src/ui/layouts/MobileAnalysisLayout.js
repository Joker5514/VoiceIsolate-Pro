/**
 * VoiceIsolate-Pro — Mobile Analysis Layout
 * Touch-native presentation with same workflow semantics as browser/desktop
 * - tap/drag selection
 * - pinch zoom
 * - horizontal timeline pan
 * - large draggable selection handles (44-48dp)
 * - bottom sheet for actions
 * - compact bottom navigation
 * - haptic confirmation
 */

import { Tokens, NavigationSections } from '../tokens/design-tokens.js';
import { getUIStore } from '../../state/uiStore.js';

export class MobileAnalysisLayout {
  constructor(container, _options = {}) {
    this.container = container;
    this._uiStore = getUIStore();
    this._els = {};
    this._initDOM();
  }

  _initDOM() {
    this.container.className = 'vip-mobile-layout';
    this.container.style.cssText = `
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      background: ${Tokens.surface.root};
      color: ${Tokens.text.primary};
      font-family: ${Tokens.font.ui};
    `;

    this.container.innerHTML = `
      <header style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:${Tokens.surface.panel}; border-bottom:1px solid ${Tokens.border.subtle}; min-height:56px;">
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="width:28px; height:28px; border-radius:${Tokens.radius.md}; background:linear-gradient(135deg, #9b6cff, #2ed5e5); display:grid; place-items:center; color:white; font-weight:700; font-size:12px;">VIP</div>
          <span style="font:700 13px/1 ${Tokens.font.ui};">VoiceIsolate</span>
          <span data-ondevice-badge></span>
        </div>
        <button data-action="settings" style="width:44px; height:44px; display:grid; place-items:center; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.md}; color:${Tokens.text.secondary};">⚙</button>
      </header>

      <div style="padding:12px 16px; background:${Tokens.surface.panel}; border-bottom:1px solid ${Tokens.border.subtle}; display:flex; gap:8px; overflow-x:auto; -webkit-overflow-scrolling:touch;">
        ${Object.values(NavigationSections).map((sec) => `
          <button data-nav="${sec}" style="flex:none; min-height:44px; padding:8px 14px; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.full}; color:${Tokens.text.secondary}; font:500 12px/1 ${Tokens.font.ui}; white-space:nowrap;">
            ${this._labelFor(sec)}
          </button>
        `).join('')}
      </div>

      <main style="flex:1; display:flex; flex-direction:column; gap:12px; padding:12px; overflow:auto;">
        <div data-signal-canvas-host style="min-height:320px;"></div>
        <div data-meters-host></div>
        <div data-comparison-host></div>
        <div data-profiles-host></div>
      </main>

      <div data-transport-host style="padding:12px; background:${Tokens.surface.panel}; border-top:1px solid ${Tokens.border.subtle}; padding-bottom:max(12px, env(safe-area-inset-bottom));"></div>

      <nav style="display:flex; justify-content:space-around; padding:8px 0 max(8px, env(safe-area-inset-bottom)); background:${Tokens.surface.panel}; border-top:1px solid ${Tokens.border.subtle}; min-height:64px;">
        ${Object.values(NavigationSections).slice(0,5).map((sec) => `
          <button data-bottom-nav="${sec}" style="flex:1; display:flex; flex-direction:column; align-items:center; gap:4px; min-height:48px; justify-content:center; background:transparent; border:0; color:${Tokens.text.secondary}; font:500 10px/1 ${Tokens.font.ui};">
            <span style="font-size:18px;">${this._iconFor(sec)}</span>
            <span>${this._labelFor(sec)}</span>
          </button>
        `).join('')}
      </nav>

      <div data-action-palette-host></div>
      <div data-export-host style="padding:12px; background:${Tokens.surface.panel};"></div>
    `;

    this._els = {
      canvasHost: this.container.querySelector('[data-signal-canvas-host]'),
      metersHost: this.container.querySelector('[data-meters-host]'),
      comparisonHost: this.container.querySelector('[data-comparison-host]'),
      profilesHost: this.container.querySelector('[data-profiles-host]'),
      exportHost: this.container.querySelector('[data-export-host]'),
      transportHost: this.container.querySelector('[data-transport-host]'),
      onDeviceBadge: this.container.querySelector('[data-ondevice-badge]'),
      actionPaletteHost: this.container.querySelector('[data-action-palette-host]'),
    };

    // Bind nav
    const bindNav = (sel) => {
      for (const btn of this.container.querySelectorAll(sel)) {
        btn.addEventListener('click', () => {
          const sec = btn.dataset.nav || btn.dataset.bottomNav;
          this._uiStore.setNavigation(sec);
          this._updateNavActive();
          try { if (navigator.vibrate) navigator.vibrate(10); } catch {}
        });
      }
    };
    bindNav('[data-nav]');
    bindNav('[data-bottom-nav]');
    this._uiStore.subscribe('NAVIGATION_CHANGED', () => this._updateNavActive());
    this._updateNavActive();
  }

  _iconFor(s) {
    return { home: '⌂', analyze: '◉', enhance: '✧', compare: '◍', export: '⤓', settings: '⚙' }[s] || '•';
  }
  _labelFor(s) {
    return { home: 'Home', analyze: 'Analyze', enhance: 'Enhance', compare: 'Compare', export: 'Export', settings: 'Settings' }[s] || s;
  }

  _updateNavActive() {
    const active = this._uiStore.getState().navigation;
    for (const btn of this.container.querySelectorAll('[data-nav], [data-bottom-nav]')) {
      const sec = btn.dataset.nav || btn.dataset.bottomNav;
      const isActive = sec === active;
      btn.style.background = isActive ? Tokens.surface.raised : 'transparent';
      btn.style.color = isActive ? Tokens.text.primary : Tokens.text.secondary;
      btn.style.borderColor = isActive ? Tokens.signal.primary : Tokens.border.subtle;
    }
  }

  getHosts() { return this._els; }

  dispose() { this.container.innerHTML = ''; }
}

export default MobileAnalysisLayout;
