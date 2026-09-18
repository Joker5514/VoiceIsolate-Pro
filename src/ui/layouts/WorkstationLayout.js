/**
 * VoiceIsolate-Pro — Workstation Layout
 * Browser/Desktop layout: signal canvas center, inspector side, transport bottom
 * Uses shared tokens, same terminology across platforms
 */

import { Tokens, NavigationSections } from '../tokens/design-tokens.js';
import { getUIStore } from '../../state/uiStore.js';

export class WorkstationLayout {
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this._uiStore = getUIStore();
    this._els = {};
    this._initDOM();
  }

  _initDOM() {
    this.container.className = 'vip-workstation-layout';
    this.container.style.cssText = `
      display: grid;
      grid-template-areas:
        "titlebar titlebar titlebar"
        "nav canvas inspector"
        "nav transport inspector";
      grid-template-columns: 220px 1fr 320px;
      grid-template-rows: 56px 1fr auto;
      min-height: 100vh;
      background: ${Tokens.surface.root};
      color: ${Tokens.text.primary};
      font-family: ${Tokens.font.ui};
    `;

    this.container.innerHTML = `
      <header data-area="titlebar" style="grid-area:titlebar; display:flex; align-items:center; justify-content:space-between; padding:0 16px; background:${Tokens.surface.panel}; border-bottom:1px solid ${Tokens.border.subtle}; height:56px;">
        <div style="display:flex; align-items:center; gap:12px;">
          <div style="width:32px; height:32px; border-radius:${Tokens.radius.lg}; background:linear-gradient(135deg, #9b6cff, #2ed5e5); display:grid; place-items:center; color:white; font-weight:700;">VIP</div>
          <span style="font:700 14px/1 ${Tokens.font.ui}; letter-spacing:-0.02em;">VoiceIsolate Pro</span>
          <span data-ondevice-badge></span>
        </div>
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font:500 11px/1 ${Tokens.font.mono}; color:${Tokens.text.dim};">Web · Private by design</span>
        </div>
      </header>
      <nav data-area="nav" style="grid-area:nav; display:flex; flex-direction:column; gap:4px; padding:16px 12px; background:${Tokens.surface.panel}; border-right:1px solid ${Tokens.border.subtle};">
        <div style="font:700 10px/1 ${Tokens.font.mono}; letter-spacing:0.12em; text-transform:uppercase; color:${Tokens.text.dim}; margin-bottom:8px;">Workspace</div>
        ${Object.values(NavigationSections).map((sec) => `
          <button data-nav="${sec}" style="display:flex; align-items:center; gap:10px; width:100%; min-height:40px; padding:8px 12px; background:transparent; border:1px solid transparent; border-radius:${Tokens.radius.md}; color:${Tokens.text.secondary}; font:500 13px/1 ${Tokens.font.ui}; cursor:pointer; text-align:left;">
            <span style="width:20px; text-align:center;">${this._iconFor(sec)}</span> ${this._labelFor(sec)}
          </button>
        `).join('')}
        <div style="margin-top:auto; padding-top:16px; border-top:1px solid ${Tokens.border.subtle}; font:400 10px/1.4 ${Tokens.font.ui}; color:${Tokens.text.ghost};">
          100% on-device<br>Zero cloud · Private
        </div>
      </nav>
      <main data-area="canvas" style="grid-area:canvas; display:flex; flex-direction:column; gap:16px; padding:16px; overflow:auto; background:${Tokens.surface.root};">
        <div data-hero style="display:none;"></div>
        <div data-signal-canvas-host style="flex:1; min-height:400px;"></div>
        <div data-action-palette-host></div>
      </main>
      <aside data-area="inspector" style="grid-area:inspector; display:flex; flex-direction:column; gap:16px; padding:16px; background:${Tokens.surface.panel}; border-left:1px solid ${Tokens.border.subtle}; overflow:auto;">
        <div data-meters-host></div>
        <div data-comparison-host></div>
        <div data-profiles-host></div>
        <div data-export-host></div>
        <details data-advanced style="border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.lg}; background:${Tokens.surface.raised};">
          <summary style="padding:12px; font:600 11px/1 ${Tokens.font.mono}; text-transform:uppercase; letter-spacing:0.08em; color:${Tokens.text.dim}; cursor:pointer;">Advanced / Engineer</summary>
          <div data-advanced-host style="padding:12px; display:flex; flex-direction:column; gap:8px;"></div>
        </details>
      </aside>
      <footer data-area="transport" style="grid-area:transport; padding:12px 16px; background:${Tokens.surface.panel}; border-top:1px solid ${Tokens.border.subtle};">
        <div data-transport-host></div>
      </footer>
    `;

    this._els = {
      nav: this.container.querySelector('[data-area="nav"]'),
      canvasHost: this.container.querySelector('[data-signal-canvas-host]'),
      metersHost: this.container.querySelector('[data-meters-host]'),
      comparisonHost: this.container.querySelector('[data-comparison-host]'),
      profilesHost: this.container.querySelector('[data-profiles-host]'),
      exportHost: this.container.querySelector('[data-export-host]'),
      advancedHost: this.container.querySelector('[data-advanced-host]'),
      transportHost: this.container.querySelector('[data-transport-host]'),
      onDeviceBadge: this.container.querySelector('[data-ondevice-badge]'),
      actionPaletteHost: this.container.querySelector('[data-action-palette-host]'),
    };

    // Bind nav
    for (const btn of this.container.querySelectorAll('[data-nav]')) {
      btn.addEventListener('click', () => {
        const sec = btn.dataset.nav;
        this._uiStore.setNavigation(sec);
        this._updateNavActive();
      });
    }
    this._uiStore.subscribe('NAVIGATION_CHANGED', () => this._updateNavActive());
    this._updateNavActive();

    // Responsive: collapse inspector on small screens
    const mq = window.matchMedia('(max-width: 1024px)');
    const handleMq = () => {
      if (mq.matches) {
        this.container.style.gridTemplateAreas = `
          "titlebar titlebar"
          "canvas canvas"
          "transport transport"
          "inspector inspector"
          "nav nav"
        `;
        this.container.style.gridTemplateColumns = '1fr';
        this.container.style.gridTemplateRows = '56px 1fr auto auto 64px';
        this._els.nav.style.flexDirection = 'row';
        this._els.nav.style.overflowX = 'auto';
      } else {
        this.container.style.gridTemplateAreas = `
          "titlebar titlebar titlebar"
          "nav canvas inspector"
          "nav transport inspector"
        `;
        this.container.style.gridTemplateColumns = '220px 1fr 320px';
        this.container.style.gridTemplateRows = '56px 1fr auto';
        this._els.nav.style.flexDirection = 'column';
      }
    };
    mq.addEventListener('change', handleMq);
    handleMq();
  }

  _iconFor(section) {
    const icons = {
      home: '⌂',
      analyze: '◉',
      enhance: '✧',
      compare: '◍',
      export: '⤓',
      settings: '⚙',
    };
    return icons[section] || '•';
  }

  _labelFor(section) {
    const labels = {
      home: 'Home',
      analyze: 'Analyze',
      enhance: 'Enhance',
      compare: 'Compare',
      export: 'Export',
      settings: 'Settings',
    };
    return labels[section] || section;
  }

  _updateNavActive() {
    const active = this._uiStore.getState().navigation;
    for (const btn of this.container.querySelectorAll('[data-nav]')) {
      const isActive = btn.dataset.nav === active;
      btn.style.background = isActive ? Tokens.surface.raised : 'transparent';
      btn.style.borderColor = isActive ? Tokens.border.strong : 'transparent';
      btn.style.color = isActive ? Tokens.text.primary : Tokens.text.secondary;
      if (isActive) btn.style.boxShadow = `inset 2px 0 0 ${Tokens.signal.primary}`;
      else btn.style.boxShadow = 'none';
    }
  }

  getHosts() {
    return this._els;
  }

  dispose() {
    this.container.innerHTML = '';
  }
}

export default WorkstationLayout;
