/**
 * public/app/diarization-timeline.js
 * VoiceIsolate Pro — Threads from Space v8
 * 
 * Diarization Timeline Component
 * ─────────────────────────────────────────────────────────────────
 * Renders a "who-spoke-when" canvas timeline fed by ml-worker.js
 * diarization messages. Wires into the existing App state object
 * and setParam() registry from app.js.
 *
 * Message contract (from ml-worker.js):
 *   { type: 'diarization', payload: { segments, duration, speakerCount } }
 *   { type: 'voiceprintEnrolled', payload: { speakerId } }
 *   { type: 'voiceprintCleared' }
 *
 * Messages sent to ml-worker.js:
 *   { type: 'isolateSpeaker', payload: { speakerId | null } }
 *   { type: 'speakerVolumes', payload: { [speakerId]: 0..1 } }
 *
 * DOM dependencies (must exist in index.html):
 *   #diarization-canvas        <canvas>
 *   #diarization-playhead      <div> absolutely positioned needle
 *   #diarization-section       parent container
 *   #diarization-zoom-in       <button>
 *   #diarization-zoom-out      <button>
 *   #diarization-zoom-fit      <button>
 *   #diarization-time-label    <span>
 */

'use strict';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const TRACK_HEIGHT      = 28;   // px per speaker row
const HEADER_HEIGHT     = 20;   // px for time ruler
const PLAYHEAD_COLOR    = '#ef4444';
const RULER_COLOR       = '#4b5563';
const RULER_TEXT_COLOR  = '#9ca3af';
const FONT              = '11px "JetBrains Mono", "Courier New", monospace';
const CONFIDENCE_ALPHA  = (c) => 0.35 + 0.65 * Math.min(1, Math.max(0, c));

const SPEAKER_PALETTE = [
  '#3b82f6', '#a855f7', '#10b981', '#f59e0b',
  '#ef4444', '#06b6d4', '#84cc16', '#f97316',
];

// ─────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────
const Timeline = {
  canvas:       null,
  ctx:          null,
  playheadEl:   null,
  container:    null,

  // diarization data
  segments:     [],   // [{speakerId, label, start, end, confidence}]
  duration:     0,    // total audio duration in seconds
  speakers:     {},   // { [id]: { label, color, volume, muted, solo } }
  activeSpeaker: null,

  // view
  viewStart:    0,    // seconds into audio where view begins
  viewDuration: 0,    // seconds visible in canvas
  zoom:         1.0,

  // playback
  currentTime:  0,
  rafId:        null,

  // external refs (set by init)
  mlWorker:     null,
  audioContext: null,
  onSpeakerSelect: null,  // callback(speakerId|null)
};

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Initialize the timeline.
 * @param {object} opts
 *   mlWorker       {Worker}       reference to App.mlWorker
 *   audioContext   {AudioContext} reference to App.audioContext
 *   onSpeakerSelect {Function}   called when user clicks a speaker segment
 */
export function initDiarizationTimeline({ mlWorker, audioContext, onSpeakerSelect } = {}) {
  Timeline.mlWorker     = mlWorker;
  Timeline.audioContext = audioContext;
  Timeline.onSpeakerSelect = onSpeakerSelect ?? (() => {});

  Timeline.canvas     = document.getElementById('diarization-canvas');
  Timeline.playheadEl = document.getElementById('diarization-playhead');
  Timeline.container  = document.getElementById('diarization-section');

  if (!Timeline.canvas) {
    console.warn('[DiarizationTimeline] #diarization-canvas not found — skipping init');
    return;
  }

  Timeline.ctx = Timeline.canvas.getContext('2d');
  _bindResize();
  _bindZoomButtons();
  _bindCanvasClick();
  _startRAF();

  console.info('[DiarizationTimeline] Initialized');
}

/**
 * Feed new diarization result from ml-worker.
 * @param {{ segments: Array, duration: number, speakerCount: number }} payload
 */
export function onDiarizationResult({ segments = [], duration = 0 }) {
  Timeline.segments = segments;
  Timeline.duration = duration;

  // Build / update speaker registry
  const seen = new Set();
  segments.forEach(seg => {
    seen.add(seg.speakerId);
    if (!Timeline.speakers[seg.speakerId]) {
      const colorIdx = Object.keys(Timeline.speakers).length % SPEAKER_PALETTE.length;
      Timeline.speakers[seg.speakerId] = {
        label:  seg.label ?? `Speaker ${seg.speakerId}`,
        color:  SPEAKER_PALETTE[colorIdx],
        volume: 1.0,
        muted:  false,
        solo:   false,
      };
    }
    // update label if provided
    if (seg.label) Timeline.speakers[seg.speakerId].label = seg.label;
  });

  // Reset view to fit entire audio on first load
  if (Timeline.viewDuration === 0 || Timeline.zoom === 1.0) {
    Timeline.viewStart    = 0;
    Timeline.viewDuration = duration;
  }

  _render();
}

/**
 * Seek the timeline playhead to a given time (seconds).
 * Called from app.js on playback position updates.
 */
export function seekTimeline(timeSec) {
  Timeline.currentTime = timeSec;
  _updatePlayheadDOM();
}

/**
 * Set per-speaker volume (0..1). Pushes update to ml-worker.
 */
export function setSpeakerVolume(speakerId, volume) {
  if (!Timeline.speakers[speakerId]) return;
  Timeline.speakers[speakerId].volume = volume;
  _pushSpeakerVolumes();
  _render();
}

/**
 * Mute / unmute a speaker. Pushes update to ml-worker.
 */
export function setSpeakerMute(speakerId, muted) {
  if (!Timeline.speakers[speakerId]) return;
  Timeline.speakers[speakerId].muted = muted;
  _pushSpeakerVolumes();
  _render();
}

/**
 * Solo a speaker (all others to 0). Pass null to clear solo.
 */
export function setSpeakerSolo(speakerId) {
  const solo = Timeline.activeSpeaker === speakerId ? null : speakerId;
  Timeline.activeSpeaker = solo;
  Timeline.mlWorker?.postMessage({ type: 'isolateSpeaker', payload: { speakerId: solo } });
  Timeline.onSpeakerSelect(solo);
  _pushSpeakerVolumes();
  _render();
}

/**
 * Update from tick — called from RAF loop.
 */
export function tickTimeline() {
  if (Timeline.audioContext) {
    Timeline.currentTime = Timeline.audioContext.currentTime;
  }
  _updatePlayheadDOM();
  _render();
}

// ─────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────

function _render() {
  const { canvas, ctx, segments, speakers, duration,
          viewStart, viewDuration, currentTime, activeSpeaker } = Timeline;
  if (!canvas || !ctx || duration === 0) return;

  const W = canvas.width;
  const H = canvas.height;
  const speakerIds = Object.keys(speakers);
  const trackCount  = speakerIds.length || 1;

  // clear
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, W, H);

  // ── Time ruler ──────────────────────────────
  _drawRuler(ctx, W, viewStart, viewDuration);

  if (segments.length === 0) {
    ctx.fillStyle = '#4b5563';
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.fillText('No diarization data — process audio to populate timeline', W / 2, H / 2);
    return;
  }

  // ── Track rows ──────────────────────────────
  speakerIds.forEach((sid, rowIdx) => {
    const spk    = speakers[sid];
    const y      = HEADER_HEIGHT + rowIdx * TRACK_HEIGHT;
    const isActive = activeSpeaker === null || activeSpeaker === sid;

    // row background
    ctx.fillStyle = rowIdx % 2 === 0 ? '#1e293b' : '#162032';
    ctx.fillRect(0, y, W, TRACK_HEIGHT);

    // speaker label pill
    ctx.fillStyle = spk.color;
    ctx.fillRect(2, y + 4, 6, TRACK_HEIGHT - 8);
    ctx.fillStyle = isActive ? '#e2e8f0' : '#64748b';
    ctx.font = FONT;
    ctx.textAlign = 'left';
    ctx.fillText(spk.label, 14, y + TRACK_HEIGHT / 2 + 4);

    // segments
    segments
      .filter(seg => seg.speakerId === sid)
      .forEach(seg => {
        const xStart = _timeToX(seg.start, W, viewStart, viewDuration);
        const xEnd   = _timeToX(seg.end,   W, viewStart, viewDuration);
        const segW   = Math.max(2, xEnd - xStart);

        const alpha = isActive ? CONFIDENCE_ALPHA(seg.confidence) : 0.2;
        ctx.globalAlpha = alpha;
        ctx.fillStyle   = spk.color;
        ctx.fillRect(xStart, y + 4, segW, TRACK_HEIGHT - 8);

        // confidence tick
        if (segW > 20 && seg.confidence != null) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(255,255,255,0.6)';
          ctx.font = '9px monospace';
          ctx.textAlign = 'left';
          const label = `${Math.round(seg.confidence * 100)}%`;
          if (segW > ctx.measureText(label).width + 4) {
            ctx.fillText(label, xStart + 3, y + TRACK_HEIGHT / 2 + 3);
          }
        }
        ctx.globalAlpha = 1;
      });
  });

  // ── Row separators ──────────────────────────
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 1;
  speakerIds.forEach((_, idx) => {
    const y = HEADER_HEIGHT + idx * TRACK_HEIGHT;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  });

  // ── Playhead ────────────────────────────────
  const px = _timeToX(currentTime, W, viewStart, viewDuration);
  if (px >= 0 && px <= W) {
    ctx.strokeStyle = PLAYHEAD_COLOR;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(px, HEADER_HEIGHT);
    ctx.lineTo(px, H);
    ctx.stroke();
    ctx.setLineDash([]);

    // playhead triangle handle
    ctx.fillStyle = PLAYHEAD_COLOR;
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 10);
    ctx.closePath();
    ctx.fill();
  }

  // ── Current time label ──────────────────────
  const timeLabel = document.getElementById('diarization-time-label');
  if (timeLabel) timeLabel.textContent = _fmtTime(currentTime);
}

function _drawRuler(ctx, W, viewStart, viewDuration) {
  ctx.fillStyle = '#1e293b';
  ctx.fillRect(0, 0, W, HEADER_HEIGHT);

  const tickInterval = _niceInterval(viewDuration / 8);
  const startTick    = Math.ceil(viewStart / tickInterval) * tickInterval;

  ctx.strokeStyle = RULER_COLOR;
  ctx.fillStyle   = RULER_TEXT_COLOR;
  ctx.font        = FONT;
  ctx.lineWidth   = 1;
  ctx.textAlign   = 'left';

  for (let t = startTick; t <= viewStart + viewDuration; t += tickInterval) {
    const x = _timeToX(t, W, viewStart, viewDuration);
    ctx.beginPath();
    ctx.moveTo(x, HEADER_HEIGHT - 6);
    ctx.lineTo(x, HEADER_HEIGHT);
    ctx.stroke();
    ctx.fillText(_fmtTime(t), x + 2, HEADER_HEIGHT - 2);
  }
}

// ─────────────────────────────────────────────
// Interaction
// ─────────────────────────────────────────────

function _bindCanvasClick() {
  Timeline.canvas.addEventListener('click', (e) => {
    const rect = Timeline.canvas.getBoundingClientRect();
    const x    = e.clientX - rect.left;
    const y    = e.clientY - rect.top;

    const speakerIds = Object.keys(Timeline.speakers);
    const rowIdx     = Math.floor((y - HEADER_HEIGHT) / TRACK_HEIGHT);
    if (rowIdx < 0 || rowIdx >= speakerIds.length) return;

    const sid = speakerIds[rowIdx];
    setSpeakerSolo(sid);

    // rebuild isolation-controls panel if wired
    document.dispatchEvent(new CustomEvent('diarization:speakerSelected', { detail: { speakerId: sid } }));
  });

  // Hover tooltip
  Timeline.canvas.addEventListener('mousemove', (e) => {
    const rect = Timeline.canvas.getBoundingClientRect();
    const x    = e.clientX - rect.left;
    const t    = _xToTime(x, Timeline.canvas.width, Timeline.viewStart, Timeline.viewDuration);

    const seg = Timeline.segments.find(s => t >= s.start && t <= s.end);
    Timeline.canvas.title = seg
      ? `${Timeline.speakers[seg.speakerId]?.label ?? seg.speakerId}  ${_fmtTime(seg.start)}–${_fmtTime(seg.end)}  conf: ${Math.round((seg.confidence ?? 1) * 100)}%`
      : _fmtTime(t);
  });
}

function _bindZoomButtons() {
  document.getElementById('diarization-zoom-in')
    ?.addEventListener('click', () => _zoom(2.0));
  document.getElementById('diarization-zoom-out')
    ?.addEventListener('click', () => _zoom(0.5));
  document.getElementById('diarization-zoom-fit')
    ?.addEventListener('click', () => {
      Timeline.viewStart    = 0;
      Timeline.viewDuration = Timeline.duration;
      Timeline.zoom         = 1.0;
      _render();
    });
}

function _zoom(factor) {
  const center          = Timeline.viewStart + Timeline.viewDuration / 2;
  Timeline.zoom         = Math.max(1.0, Math.min(200, Timeline.zoom * factor));
  Timeline.viewDuration = Math.max(1, Timeline.duration / Timeline.zoom);
  Timeline.viewStart    = Math.max(0, Math.min(center - Timeline.viewDuration / 2, Timeline.duration - Timeline.viewDuration));
  _render();
}

function _bindResize() {
  const ro = new ResizeObserver(() => {
    if (!Timeline.canvas || !Timeline.container) return;
    const speakerCount = Math.max(1, Object.keys(Timeline.speakers).length);
    Timeline.canvas.width  = Timeline.container.clientWidth;
    Timeline.canvas.height = HEADER_HEIGHT + speakerCount * TRACK_HEIGHT;
    _render();
  });
  ro.observe(Timeline.container);
}

// ─────────────────────────────────────────────
// RAF loop
// ─────────────────────────────────────────────

function _startRAF() {
  const loop = () => {
    Timeline.rafId = requestAnimationFrame(loop);
    tickTimeline();
  };
  Timeline.rafId = requestAnimationFrame(loop);
}

// ─────────────────────────────────────────────
// Worker comms
// ─────────────────────────────────────────────

function _pushSpeakerVolumes() {
  const volumes = {};
  const hasSolo = Object.values(Timeline.speakers).some(s => s.solo);
  Object.entries(Timeline.speakers).forEach(([sid, spk]) => {
    const effective = spk.muted ? 0 : (hasSolo && !spk.solo ? 0 : spk.volume);
    volumes[sid] = effective;
  });
  Timeline.mlWorker?.postMessage({ type: 'speakerVolumes', payload: volumes });
}

// ─────────────────────────────────────────────
// DOM playhead sync
// ─────────────────────────────────────────────

function _updatePlayheadDOM() {
  if (!Timeline.playheadEl || !Timeline.canvas) return;
  const x = _timeToX(Timeline.currentTime, Timeline.canvas.width, Timeline.viewStart, Timeline.viewDuration);
  Timeline.playheadEl.style.left = `${x}px`;
}

// ─────────────────────────────────────────────
// Math helpers
// ─────────────────────────────────────────────

function _timeToX(t, W, viewStart, viewDuration) {
  return ((t - viewStart) / viewDuration) * W;
}
function _xToTime(x, W, viewStart, viewDuration) {
  return viewStart + (x / W) * viewDuration;
}
function _fmtTime(s) {
  const m  = Math.floor(s / 60);
  const ss = (s % 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2,'0')}:${ss}`;
}
function _niceInterval(approx) {
  const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  return nice.find(v => v >= approx) ?? 300;
}
