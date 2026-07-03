/**
 * speaker-ui.js — Dynamic speaker isolation panel for VoiceIsolate Pro
 *
 * Renders per-speaker strips (avatar, mute, gain, activity mini-waveform)
 * and wires them to SpeakerMixer controls.
 */
'use strict';

const SPEAKER_COLORS = Object.freeze([
  '#4f98a3', '#a86fdf', '#fdab43', '#6daa45', '#dd6974', '#5591c7',
]);

const MIC_SVG = `<svg class="speaker-strip__mic-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
  <path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V19H9v2h6v-2h-2v-1.08A7 7 0 0 0 19 11h-2z"/>
</svg>`;

let _stylesInjected = false;

function ensureStyles() {
  if (_stylesInjected || typeof document === 'undefined') return;
  _stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'vip-speaker-ui-styles';
  style.textContent = `
    .speaker-strip-grid { display:flex; flex-direction:column; gap:10px; }
    .speaker-strip {
      display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:center;
      padding:10px 12px; border-radius:8px;
      background:var(--color-surface-2, #1e293b);
      border:1px solid var(--color-border, #334155);
      transition:border-color .15s, box-shadow .15s, opacity .15s;
    }
    .speaker-strip--muted { opacity:0.45; }
    .speaker-strip--active {
      border-color:var(--color-primary, #3b82f6);
      box-shadow:0 0 0 2px var(--color-primary-highlight, rgba(59,130,246,.25));
    }
    .speaker-strip__avatar {
      width:36px; height:36px; border-radius:50%; flex-shrink:0;
      display:flex; align-items:center; justify-content:center;
      font-weight:700; font-size:13px; color:#0f172a;
    }
    .speaker-strip__meta { min-width:0; }
    .speaker-strip__label { font-size:13px; font-weight:600; color:#e2e8f0; }
    .speaker-strip__pct { font-size:11px; color:#94a3b8; margin-top:2px; }
    .speaker-strip__controls { display:flex; flex-direction:column; gap:6px; align-items:flex-end; }
    .speaker-strip__mute {
      display:inline-flex; align-items:center; gap:4px;
      padding:4px 8px; border-radius:6px; border:1px solid var(--color-border, #334155);
      background:var(--color-surface-1, #0f172a); color:#e2e8f0; cursor:pointer;
    }
    .speaker-strip__mute--muted { color:var(--color-error, #ef4444); }
    .speaker-strip__mute--muted .speaker-strip__mic-strike { display:block; }
    .speaker-strip__mic-strike {
      display:none; position:absolute; width:22px; height:2px;
      background:var(--color-error, #ef4444); transform:rotate(-35deg); top:8px; left:0;
    }
    .speaker-strip__gain { width:120px; accent-color:var(--color-primary, #3b82f6); }
    .speaker-strip__wave { display:block; border-radius:4px; background:#0f172a; }
  `;
  document.head.appendChild(style);
}

function speakerLabel(id, index) {
  return `Speaker ${index + 1}`;
}

function speakingPercent(timeline, speakerId) {
  const total = timeline.totalSamples || 1;
  let sum = 0;
  for (const seg of timeline.segments || []) {
    if (seg.speakerId === speakerId) sum += seg.endSample - seg.startSample;
  }
  return (sum / total) * 100;
}

function drawActivityCanvas(canvas, timeline, speakerId, color) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const total = timeline.totalSamples || 1;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.3;
  for (const seg of timeline.segments || []) {
    if (seg.speakerId !== speakerId) continue;
    const x0 = (seg.startSample / total) * w;
    const x1 = (seg.endSample / total) * w;
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
  }
  ctx.globalAlpha = 1;
}

export class SpeakerUI {
  constructor() {
    /** @type {HTMLElement|null} */
    this._container = null;
    /** @type {import('./speaker-mixer.js').SpeakerMixer|null} */
    this._mixer = null;
    /** @type {import('./speaker-diarizer.js').SpeakerTimeline|null} */
    this._timeline = null;
    /** @type {Map<string, HTMLElement>} */
    this._strips = new Map();
  }

  /**
   * Render speaker strips into container and wire to mixer.
   * @param {import('./speaker-diarizer.js').SpeakerTimeline} timeline
   * @param {import('./speaker-mixer.js').SpeakerMixer} mixer
   * @param {HTMLElement} container
   */
  render(timeline, mixer, container) {
    if (!container) return;
    ensureStyles();
    this.clear(container);
    this._container = container;
    this._mixer = mixer;
    this._timeline = timeline;

    const grid = document.createElement('div');
    grid.className = 'speaker-strip-grid';

    const speakerIds = [...timeline.speakers.keys()].sort();
    speakerIds.forEach((speakerId, index) => {
      const info = timeline.speakers.get(speakerId);
      const color = info?.color || SPEAKER_COLORS[index % SPEAKER_COLORS.length];
      const pct = speakingPercent(timeline, speakerId).toFixed(1);

      const strip = document.createElement('div');
      strip.className = 'speaker-strip';
      strip.dataset.speakerId = speakerId;

      const avatar = document.createElement('div');
      avatar.className = 'speaker-strip__avatar';
      avatar.style.background = color;
      avatar.textContent = String(index + 1);

      const meta = document.createElement('div');
      meta.className = 'speaker-strip__meta';
      meta.innerHTML = `
        <div class="speaker-strip__label">${speakerLabel(speakerId, index)}</div>
        <div class="speaker-strip__pct">${pct}% speaking time</div>
      `;

      const controls = document.createElement('div');
      controls.className = 'speaker-strip__controls';

      const muteBtn = document.createElement('button');
      muteBtn.type = 'button';
      muteBtn.className = 'speaker-strip__mute';
      muteBtn.style.position = 'relative';
      muteBtn.setAttribute('aria-label', `Mute ${speakerLabel(speakerId, index)}`);
      muteBtn.setAttribute('title', `Mute ${speakerLabel(speakerId, index)}`);
      muteBtn.innerHTML = `${MIC_SVG}<span class="speaker-strip__mic-strike"></span>`;

      muteBtn.addEventListener('click', () => {
        const muted = mixer.toggleMute(speakerId);
        muteBtn.classList.toggle('speaker-strip__mute--muted', muted);
        strip.classList.toggle('speaker-strip--muted', muted);
        const label = muted ? `Unmute ${speakerLabel(speakerId, index)}` : `Mute ${speakerLabel(speakerId, index)}`;
        muteBtn.setAttribute('aria-label', label);
        muteBtn.setAttribute('title', label);
      });

      const gainSlider = document.createElement('input');
      gainSlider.type = 'range';
      gainSlider.className = 'speaker-strip__gain';
      gainSlider.min = '0';
      gainSlider.max = '2';
      gainSlider.step = '0.01';
      gainSlider.value = '1';
      gainSlider.setAttribute('aria-label', `Gain for ${speakerLabel(speakerId, index)}`);
      gainSlider.addEventListener('input', () => {
        mixer.setSpeakerGain(speakerId, parseFloat(gainSlider.value));
      });

      const wave = document.createElement('canvas');
      wave.className = 'speaker-strip__wave';
      wave.width = 120;
      wave.height = 40;
      wave.setAttribute('aria-label', `Activity timeline for ${speakerLabel(speakerId, index)}`);
      drawActivityCanvas(wave, timeline, speakerId, color);

      controls.appendChild(muteBtn);
      controls.appendChild(gainSlider);
      controls.appendChild(wave);

      strip.appendChild(avatar);
      strip.appendChild(meta);
      strip.appendChild(controls);
      grid.appendChild(strip);
      this._strips.set(speakerId, strip);
    });

    container.appendChild(grid);
  }

  /**
   * Highlight the strip for the speaker active at currentTime (seconds).
   * Call from a requestAnimationFrame loop in the host app.
   * @param {string|null} speakerId
   * @param {number} [_currentTime]
   */
  highlightActiveSpeaker(speakerId, _currentTime = 0) {
    for (const [id, el] of this._strips) {
      el.classList.toggle('speaker-strip--active', id === speakerId);
    }
  }

  /**
   * Resolve which speaker is active at a playback time.
   * @param {number} currentTimeSec
   * @returns {string|null}
   */
  speakerAtTime(currentTimeSec) {
    if (!this._timeline?.segments?.length) return null;
    const sr = this._timeline.analysisSampleRate || 16000;
    const sample = Math.floor(currentTimeSec * sr);
    for (const seg of this._timeline.segments) {
      if (sample >= seg.startSample && sample < seg.endSample) return seg.speakerId;
    }
    return null;
  }

  /**
   * Convenience: highlight by playback clock.
   * @param {number} currentTimeSec
   */
  highlightAtTime(currentTimeSec) {
    this.highlightActiveSpeaker(this.speakerAtTime(currentTimeSec), currentTimeSec);
  }

  /**
   * Remove all speaker strips.
   * @param {HTMLElement} container
   */
  clear(container) {
    if (container) container.replaceChildren();
    this._strips.clear();
    this._container = null;
    this._mixer = null;
    this._timeline = null;
  }
}

export default SpeakerUI;