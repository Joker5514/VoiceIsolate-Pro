/**
 * VoiceIsolate-Pro — Transport
 * Playback controls with synchronized timeline, zoom/pan, playback cursor, region markers
 */

import { Tokens } from '../../tokens/design-tokens.js';

export class Transport {
  constructor(container, options = {}) {
    this.container = container;
    this.options = {
      duration: 0,
      sampleRate: 48000,
      ...options,
    };
    this._state = {
      playing: false,
      currentTime: 0,
      duration: options.duration || 0,
      loop: false,
      crop: { in: 0, out: options.duration || 0 },
      playbackRate: 1,
    };
    this._listeners = new Map();
    this._raf = 0;
    this._els = {};
    this._initDOM();
    this._bindEvents();
  }

  _initDOM() {
    this.container.className = 'vip-transport';
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
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <div style="display:flex; gap:4px;">
          <button data-action="play" aria-label="Play" title="Play (Space)" style="width:36px; height:36px; display:grid; place-items:center; background:${Tokens.surface.raised}; border:1px solid ${Tokens.border.strong}; border-radius:${Tokens.radius.md}; color:${Tokens.text.primary}; cursor:pointer; font-size:14px;">▶</button>
          <button data-action="pause" aria-label="Pause" title="Pause (Space)" style="width:36px; height:36px; display:grid; place-items:center; background:${Tokens.surface.raised}; border:1px solid ${Tokens.border.strong}; border-radius:${Tokens.radius.md}; color:${Tokens.text.secondary}; cursor:pointer; font-size:14px;">⏸</button>
          <button data-action="stop" aria-label="Stop" title="Stop" style="width:36px; height:36px; display:grid; place-items:center; background:${Tokens.surface.raised}; border:1px solid ${Tokens.border.strong}; border-radius:${Tokens.radius.md}; color:${Tokens.text.secondary}; cursor:pointer; font-size:14px;">⏹</button>
        </div>
        <div style="display:flex; align-items:center; gap:8px; margin-left:8px;">
          <span data-time-current style="font:500 12px/1 ${Tokens.font.mono}; color:${Tokens.text.primary}; font-variant-numeric:tabular-nums;">0:00.00</span>
          <span style="color:${Tokens.text.dim};">/</span>
          <span data-time-duration style="font:500 12px/1 ${Tokens.font.mono}; color:${Tokens.text.dim}; font-variant-numeric:tabular-nums;">0:00.00</span>
        </div>
        <div style="margin-left:auto; display:flex; gap:6px; align-items:center;">
          <label style="font:500 10px/1 ${Tokens.font.ui}; color:${Tokens.text.dim}; text-transform:uppercase;">Speed</label>
          <select data-speed style="background:${Tokens.surface.raised}; border:1px solid ${Tokens.border.strong}; border-radius:4px; color:${Tokens.text.primary}; font:500 11px/1 ${Tokens.font.ui}; padding:4px 6px;">
            <option value="0.5">0.5x</option>
            <option value="0.75">0.75x</option>
            <option value="1" selected>1x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>
          <button data-action="loop" aria-pressed="false" title="Loop (L)" style="min-height:28px; padding:4px 10px; font:500 11px/1 ${Tokens.font.ui}; background:${Tokens.surface.raised}; border:1px solid ${Tokens.border.strong}; border-radius:${Tokens.radius.md}; color:${Tokens.text.secondary}; cursor:pointer;">Loop</button>
        </div>
      </div>
      <div style="position:relative; height:32px; display:flex; align-items:center;">
        <div data-timeline style="position:relative; width:100%; height:24px; background:${Tokens.surface.raised}; border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.md}; overflow:hidden; cursor:pointer;">
          <div data-progress style="position:absolute; left:0; top:0; bottom:0; width:0%; background:linear-gradient(to right, ${Tokens.signal.primary}33, ${Tokens.signal.primary}66); pointer-events:none;"></div>
          <div data-cursor style="position:absolute; top:0; bottom:0; width:2px; background:${Tokens.text.primary}; pointer-events:none; transform:translateX(0);">
            <div style="position:absolute; top:-4px; left:50%; transform:translateX(-50%); width:8px; height:8px; background:${Tokens.text.primary}; border-radius:50%;"></div>
          </div>
          <div data-crop style="position:absolute; top:0; bottom:0; border:1px dashed ${Tokens.warning.default}; background:rgba(240,181,65,0.08); pointer-events:none; display:none;"></div>
        </div>
        <input data-seek type="range" min="0" max="1000" value="0" aria-label="Seek" style="position:absolute; inset:0; width:100%; height:100%; opacity:0; cursor:pointer;">
      </div>
      <div style="display:flex; gap:6px;">
        <button data-action="cropIn" style="min-height:28px; padding:4px 10px; font:500 10px/1 ${Tokens.font.ui}; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.md}; color:${Tokens.text.secondary}; cursor:pointer;">In</button>
        <button data-action="cropOut" style="min-height:28px; padding:4px 10px; font:500 10px/1 ${Tokens.font.ui}; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.md}; color:${Tokens.text.secondary}; cursor:pointer;">Out</button>
        <button data-action="cropClear" style="min-height:28px; padding:4px 10px; font:500 10px/1 ${Tokens.font.ui}; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.md}; color:${Tokens.text.secondary}; cursor:pointer;">Clear</button>
        <div style="margin-left:auto; display:flex; gap:6px;">
          <button data-action="zoomToSelection" style="min-height:28px; padding:4px 10px; font:500 10px/1 ${Tokens.font.ui}; background:transparent; border:1px solid ${Tokens.border.subtle}; border-radius:${Tokens.radius.md}; color:${Tokens.text.secondary}; cursor:pointer;">Zoom to Selection</button>
        </div>
      </div>
    `;

    this._els.current = this.container.querySelector('[data-time-current]');
    this._els.duration = this.container.querySelector('[data-time-duration]');
    this._els.progress = this.container.querySelector('[data-progress]');
    this._els.cursor = this.container.querySelector('[data-cursor]');
    this._els.crop = this.container.querySelector('[data-crop]');
    this._els.seek = this.container.querySelector('[data-seek]');
    this._els.timeline = this.container.querySelector('[data-timeline]');
    this._els.playBtn = this.container.querySelector('[data-action="play"]');
    this._els.pauseBtn = this.container.querySelector('[data-action="pause"]');
    this._els.stopBtn = this.container.querySelector('[data-action="stop"]');
    this._els.loopBtn = this.container.querySelector('[data-action="loop"]');
    this._els.speed = this.container.querySelector('[data-speed]');
  }

  _bindEvents() {
    this._els.playBtn.addEventListener('click', () => this._emit('play'));
    this._els.pauseBtn.addEventListener('click', () => this._emit('pause'));
    this._els.stopBtn.addEventListener('click', () => this._emit('stop'));
    this._els.loopBtn.addEventListener('click', () => {
      this._state.loop = !this._state.loop;
      this._els.loopBtn.setAttribute('aria-pressed', String(this._state.loop));
      this._els.loopBtn.style.background = this._state.loop ? Tokens.signal.primary : Tokens.surface.raised;
      this._els.loopBtn.style.color = this._state.loop ? 'white' : Tokens.text.secondary;
      this._emit('loop', this._state.loop);
    });
    this._els.speed.addEventListener('change', () => {
      const rate = parseFloat(this._els.speed.value) || 1;
      this._state.playbackRate = rate;
      this._emit('rate', rate);
    });
    this._els.seek.addEventListener('input', () => {
      const frac = parseInt(this._els.seek.value, 10) / 1000;
      const time = frac * this._state.duration;
      this._emit('seek', time);
    });
    this.container.querySelector('[data-action="cropIn"]').addEventListener('click', () => {
      this._emit('cropIn', this._state.currentTime);
    });
    this.container.querySelector('[data-action="cropOut"]').addEventListener('click', () => {
      this._emit('cropOut', this._state.currentTime);
    });
    this.container.querySelector('[data-action="cropClear"]').addEventListener('click', () => {
      this._emit('cropClear');
    });
    this.container.querySelector('[data-action="zoomToSelection"]').addEventListener('click', () => {
      this._emit('zoomToSelection');
    });

    // Keyboard shortcuts
    if (!this.container.hasAttribute('tabindex')) this.container.setAttribute('tabindex', '0');
    this.container.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        this._emit(this._state.playing ? 'pause' : 'play');
      } else if (e.key.toLowerCase() === 'l') {
        this._els.loopBtn.click();
      }
    });

    // Timeline click
    this._els.timeline.addEventListener('click', (e) => {
      const rect = this._els.timeline.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / rect.width;
      this._emit('seek', frac * this._state.duration);
    });
  }

  setState(patch) {
    this._state = { ...this._state, ...patch };
    this._updateDOM();
  }

  _updateDOM() {
    const s = this._state;
    this._els.current.textContent = this._formatTime(s.currentTime);
    this._els.duration.textContent = this._formatTime(s.duration);
    this._els.seek.max = '1000';
    const frac = s.duration > 0 ? s.currentTime / s.duration : 0;
    this._els.seek.value = String(Math.round(frac * 1000));
    this._els.progress.style.width = `${frac * 100}%`;
    this._els.cursor.style.left = `${frac * 100}%`;

    // Crop
    if (s.crop && s.crop.out > s.crop.in) {
      const inFrac = s.crop.in / Math.max(0.001, s.duration);
      const outFrac = s.crop.out / Math.max(0.001, s.duration);
      this._els.crop.style.display = 'block';
      this._els.crop.style.left = `${inFrac * 100}%`;
      this._els.crop.style.width = `${(outFrac - inFrac) * 100}%`;
    } else {
      this._els.crop.style.display = 'none';
    }

    // Play/pause state
    this._els.playBtn.style.display = s.playing ? 'none' : 'grid';
    this._els.pauseBtn.style.display = s.playing ? 'grid' : 'none';
  }

  _formatTime(sec) {
    if (!isFinite(sec)) return '0:00.00';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toFixed(2).padStart(5, '0')}`;
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
    if (this._raf) cancelAnimationFrame(this._raf);
  }
}

export default Transport;
