/**
 * diarization-timeline.js
 * VoiceIsolate Pro v22 — Threads from Space v11
 *
 * Renders a scrollable/zoomable speaker-diarization timeline onto
 * a <canvas> element. Driven entirely by data pushed from ml-worker.js
 * via the PipelineOrchestrator message bus.
 *
 * Exports (used by index.html bridge):
 *   initDiarizationTimeline(opts)   — one-time setup
 *   onDiarizationResult(result)     — called when worker posts 'diarization'
 *   seekTimeline(currentTimeSec)    — called every RAF tick from app.js
 *   zoomTimeline(factor)            — called by +/- buttons
 *   fitTimeline()                   — called by ⤢ button
 *   setSpeakerVolume(id, vol)       — from speaker card sliders
 *   setSpeakerMute(id, muted)       — from speaker card mute buttons
 *   setSpeakerSolo(id, solo)        — from speaker card solo buttons
 */

'use strict';

// ── Module state ────────────────────────────────────────────────────────────
let _canvas       = null;
let _ctx          = null;
let _playheadEl   = null;
let _timeLabelEl  = null;
let _countEl      = null;
let _onSpeakerClick = null;

let _segments    = [];      // [{speakerId, label, start, end, confidence}]
let _duration    = 0;       // seconds
let _currentTime = 0;       // seconds
let _viewStart   = 0;       // seconds — left edge of view
let _viewEnd     = 0;       // seconds — right edge of view
let _zoom        = 1;
let _isDragging  = false;
let _dragStartX  = 0;
let _dragViewStart = 0;
let _rafId       = null;

const PALETTE = [
  '#3b82f6','#a855f7','#10b981','#f59e0b',
  '#ef4444','#06b6d4','#84cc16','#f97316',
];
const SPEAKER_COLORS = {};
let _colorIndex = 0;

function _getSpeakerColor(id) {
  if (!SPEAKER_COLORS[id]) {
    SPEAKER_COLORS[id] = PALETTE[_colorIndex++ % PALETTE.length];
  }
  return SPEAKER_COLORS[id];
}

// ── Public: init ─────────────────────────────────────────────────────────────
export function initDiarizationTimeline(opts = {}) {
  const canvasId = opts.canvasId || 'diarCanvas';
  _canvas = document.getElementById(canvasId);
  if (!_canvas) { console.warn('[DiarTimeline] canvas not found:', canvasId); return; }
  _ctx          = _canvas.getContext('2d');
  _playheadEl   = document.getElementById(opts.playheadId   || 'diarPlayhead');
  _timeLabelEl  = document.getElementById(opts.timeLabelId  || 'diarTimeLabel');
  _countEl      = document.getElementById(opts.speakerCountId || 'diarSpeakerCount');
  _onSpeakerClick = opts.onSpeakerClick || null;

  // Resize observer
  const ro = new ResizeObserver(() => _resize());
  ro.observe(_canvas.parentElement || _canvas);
  _resize();

  // Mouse / touch drag to pan
  _canvas.addEventListener('mousedown',  _onMouseDown);
  _canvas.addEventListener('mousemove',  _onMouseMove);
  _canvas.addEventListener('mouseup',    _onMouseUp);
  _canvas.addEventListener('mouseleave', _onMouseUp);
  _canvas.addEventListener('click',      _onClick);
  _canvas.addEventListener('wheel',      _onWheel, { passive: true });

  // Touch
  _canvas.addEventListener('touchstart', e => _onMouseDown({ clientX: e.touches[0].clientX }), { passive: true });
  _canvas.addEventListener('touchmove',  e => { e.preventDefault(); _onMouseMove({ clientX: e.touches[0].clientX }); }, { passive: false });
  _canvas.addEventListener('touchend',   _onMouseUp, { passive: true });

  _startRAF();
  console.info('[DiarTimeline] initialised on #' + canvasId);
}

// ── Public: data update ───────────────────────────────────────────────────────
export function onDiarizationResult({ segments = [], duration = 0, speakerCount = 0 }) {
  _segments = segments;
  _duration = duration || (segments.length ? Math.max(...segments.map(s => s.end)) : 0);
  _viewStart = 0;
  _viewEnd   = _duration;

  // Update badge
  if (_countEl) {
    const n = speakerCount || new Set(segments.map(s => s.speakerId)).size;
    _countEl.textContent = n + ' speaker' + (n !== 1 ? 's' : '');
  }
  // Show playhead
  if (_playheadEl) _playheadEl.style.display = 'block';
}

// ── Public: playhead sync ─────────────────────────────────────────────────────
export function seekTimeline(timeSec) {
  _currentTime = timeSec;
  if (_timeLabelEl) _timeLabelEl.textContent = _fmtTime(timeSec);

  // Auto-scroll: keep playhead in view
  const viewLen = _viewEnd - _viewStart;
  if (_duration > 0 && timeSec > _viewEnd - viewLen * 0.1) {
    _viewStart = Math.min(timeSec - viewLen * 0.1, _duration - viewLen);
    _viewEnd   = _viewStart + viewLen;
  }
  // Sync playhead DOM element
  if (_playheadEl && _canvas && _duration > 0) {
    const frac = (_currentTime - _viewStart) / (_viewEnd - _viewStart);
    const px   = Math.max(0, Math.min(_canvas.offsetWidth, frac * _canvas.offsetWidth));
    _playheadEl.style.left = px + 'px';
    _playheadEl.style.display = 'block';
  }
}

// ── Public: zoom ──────────────────────────────────────────────────────────────
export function zoomTimeline(factor) {
  if (!_duration) return;
  const center  = (_viewStart + _viewEnd) / 2;
  const halfLen = (_viewEnd - _viewStart) / 2 / factor;
  _viewStart = Math.max(0, center - halfLen);
  _viewEnd   = Math.min(_duration, center + halfLen);
}

export function fitTimeline() {
  _viewStart = 0;
  _viewEnd   = _duration || 1;
}

// ── Public: speaker state passthrough ─────────────────────────────────────────
export function setSpeakerVolume(id, vol) { /* consumed by isolation-controls.js */ }
export function setSpeakerMute(id, muted) { /* consumed by isolation-controls.js */ }
export function setSpeakerSolo(id, solo)  { /* consumed by isolation-controls.js */ }

// ── Internal: render ──────────────────────────────────────────────────────────
function _resize() {
  if (!_canvas) return;
  const parent = _canvas.parentElement;
  const w = parent ? parent.clientWidth : 600;
  const h = Math.max(80, _canvas.clientHeight || 90);
  _canvas.width  = w * devicePixelRatio;
  _canvas.height = h * devicePixelRatio;
  _canvas.style.width  = w + 'px';
  _canvas.style.height = h + 'px';
  if (_ctx) _ctx.scale(devicePixelRatio, devicePixelRatio);
  if (!_viewEnd && _duration) _viewEnd = _duration;
}

function _draw() {
  if (!_ctx || !_canvas) return;
  const W = _canvas.width  / devicePixelRatio;
  const H = _canvas.height / devicePixelRatio;
  const cx = _ctx;

  cx.clearRect(0, 0, W, H);
  cx.fillStyle = '#0f172a';
  cx.fillRect(0, 0, W, H);

  if (!_segments.length || !_duration) {
    cx.fillStyle = '#334155';
    cx.font = '12px system-ui,sans-serif';
    cx.textAlign = 'center';
    cx.fillText('Process audio to see speaker timeline', W / 2, H / 2 + 4);
    return;
  }

  const viewLen = Math.max(0.001, _viewEnd - _viewStart);
  const toX = t => ((t - _viewStart) / viewLen) * W;

  // Lane height
  const LANE_H = Math.min(32, (H - 28) / Math.max(1, new Set(_segments.map(s => s.speakerId)).size));
  const speakerOrder = [...new Set(_segments.map(s => s.speakerId))];

  // Background grid (time ticks)
  cx.strokeStyle = '#1e293b';
  cx.lineWidth   = 1;
  const tickStep = _niceTick(viewLen, 8);
  const firstTick = Math.ceil(_viewStart / tickStep) * tickStep;
  for (let t = firstTick; t <= _viewEnd; t += tickStep) {
    const x = Math.round(toX(t));
    cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, H - 18); cx.stroke();
    cx.fillStyle = '#64748b';
    cx.font = '9px monospace';
    cx.textAlign = 'center';
    cx.fillText(_fmtTime(t), x, H - 6);
  }

  // Segments
  _segments.forEach(seg => {
    const lane = speakerOrder.indexOf(seg.speakerId);
    const x1   = toX(seg.start);
    const x2   = toX(seg.end);
    const y    = 4 + lane * (LANE_H + 2);
    const w    = Math.max(2, x2 - x1);

    const col  = _getSpeakerColor(seg.speakerId);
    cx.fillStyle = col + Math.round((seg.confidence || 0.8) * 255).toString(16).padStart(2, '0');
    cx.beginPath();
    cx.roundRect ? cx.roundRect(x1, y, w, LANE_H, 3) : cx.rect(x1, y, w, LANE_H);
    cx.fill();

    // Label inside segment if wide enough
    if (w > 40) {
      cx.fillStyle = '#fff';
      cx.font = '10px system-ui,sans-serif';
      cx.textAlign = 'left';
      cx.fillText(seg.label || seg.speakerId, x1 + 4, y + LANE_H / 2 + 4);
    }
  });

  // Playhead
  if (_duration > 0) {
    const phX = toX(_currentTime);
    cx.strokeStyle = '#ef4444';
    cx.lineWidth   = 2;
    cx.beginPath(); cx.moveTo(phX, 0); cx.lineTo(phX, H - 18); cx.stroke();
    // Triangle head
    cx.fillStyle = '#ef4444';
    cx.beginPath(); cx.moveTo(phX - 5, 0); cx.lineTo(phX + 5, 0); cx.lineTo(phX, 8); cx.closePath(); cx.fill();
  }
}

function _startRAF() {
  const loop = () => { _draw(); _rafId = requestAnimationFrame(loop); };
  _rafId = requestAnimationFrame(loop);
}

// ── Internal: interaction ─────────────────────────────────────────────────────
function _onClick(e) {
  if (!_duration || !_canvas || _isDragging) return;
  const rect  = _canvas.getBoundingClientRect();
  const frac  = (e.clientX - rect.left) / rect.width;
  const timeSec = _viewStart + frac * (_viewEnd - _viewStart);
  // Find clicked segment
  const hit = _segments.find(s => timeSec >= s.start && timeSec <= s.end);
  if (hit && _onSpeakerClick) _onSpeakerClick(hit.speakerId);
}

function _onMouseDown(e) {
  _isDragging    = false;
  _dragStartX    = e.clientX;
  _dragViewStart = _viewStart;
  _canvas.style.cursor = 'grabbing';
}
function _onMouseMove(e) {
  if (e.buttons === 0 && !_isDragging) return;
  const dx   = e.clientX - _dragStartX;
  if (Math.abs(dx) > 4) _isDragging = true;
  if (!_isDragging || !_canvas) return;
  const viewLen = _viewEnd - _viewStart;
  const dSec    = (dx / _canvas.offsetWidth) * viewLen;
  _viewStart    = Math.max(0, Math.min(_duration - viewLen, _dragViewStart - dSec));
  _viewEnd      = _viewStart + viewLen;
}
function _onMouseUp() {
  _isDragging = false;
  if (_canvas) _canvas.style.cursor = 'crosshair';
}
function _onWheel(e) {
  const factor = e.deltaY < 0 ? 1.15 : 0.87;
  zoomTimeline(factor);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _fmtTime(s) {
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(1).padStart(4, '0');
  return m + ':' + sec;
}
function _niceTick(range, maxTicks) {
  const raw  = range / maxTicks;
  const exp  = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const nice = [1, 2, 5, 10].map(n => n * base).find(n => n >= raw) || base;
  return nice;
}
