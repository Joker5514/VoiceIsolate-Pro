/**
 * isolation-controls.js
 * VoiceIsolate Pro v22 — Threads from Space v11
 *
 * Dynamically renders per-speaker control cards inside #speakerCardsGrid.
 * Cards include: volume slider, mute, solo, "Enroll Voiceprint" buttons.
 * Driven by data from the diarization pipeline.
 */

'use strict';

// ── Module state ────────────────────────────────────────────────────────────
let _gridEl         = null;
let _mlWorker       = null;
let _audioContext   = null;
let _onSolo         = null;
let _onMute         = null;
let _onVolume       = null;
let _onEnrollFromSeg= null;

let _speakerMap  = {};   // { id: { label, color, volume, muted, solo } }
let _activeSoloId = null;

const PALETTE = [
  '#3b82f6','#a855f7','#10b981','#f59e0b',
  '#ef4444','#06b6d4','#84cc16','#f97316',
];
let _colorIdx = 0;

// ── Public: init ─────────────────────────────────────────────────────────────
export function initIsolationControls(opts = {}) {
  _gridEl          = document.getElementById(opts.gridId || 'speakerCardsGrid');
  _mlWorker        = opts.mlWorker       || null;
  _audioContext    = opts.audioContext   || null;
  _onSolo          = opts.onSolo         || null;
  _onMute          = opts.onMute         || null;
  _onVolume        = opts.onVolume       || null;
  _onEnrollFromSeg = opts.onEnrollFromSeg|| null;
  if (!_gridEl) { console.warn('[IsolationControls] grid element not found'); return; }
  console.info('[IsolationControls] initialised');
}

// Public: attach ML worker after init. Allows the UI to bind eagerly
// (no orchestrator/worker needed yet) and have the worker plumb in once
// it's ready, so messages from solo/isolate/enroll always reach a worker.
export function attachMLWorker(worker) {
  _mlWorker = worker || null;
}

// Lazy resolver: prefer the explicit ref, fall back to the global
// orchestrator's worker so messages aren't dropped if init ran before
// the worker was attached.
function _getMLWorker() {
  return _mlWorker || (typeof window !== 'undefined' ? window._vipOrch?.mlWorker : null) || null;
}

// ── Public: update speaker cards from diarization result ─────────────────────
export function updateSpeakerCards(speakerMap) {
  // Rebuild from the latest diarization result while preserving user state
  // for speaker IDs that still exist in the new map.
  const incomingSpeakerMap = speakerMap || {};
  const nextSpeakerMap = {};

  Object.entries(incomingSpeakerMap).forEach(([id, info]) => {
    const prev = _speakerMap[id];
    nextSpeakerMap[id] = {
      label:  info.label || (prev && prev.label) || ('Speaker ' + id),
      color:  info.color || (prev && prev.color) || PALETTE[_colorIdx++ % PALETTE.length],
      volume: prev ? prev.volume : 1.0,
      muted:  prev ? prev.muted  : false,
      solo:   prev ? prev.solo   : false,
    };
  });

  _speakerMap = nextSpeakerMap;

  if (_activeSoloId && !_speakerMap[_activeSoloId]) {
    _activeSoloId = null;
  }
  _rebuildGrid();
}

// ── Public: highlight the active (currently-speaking) card ───────────────────
export function setActiveSpeakerCard(speakerId) {
  document.querySelectorAll('.speaker-card').forEach(el => {
    el.classList.toggle('speaker-card--active', el.dataset.speakerId === speakerId);
  });
}

// ── Internal: rebuild DOM grid ────────────────────────────────────────────────
function _rebuildGrid() {
  if (!_gridEl) return;
  _gridEl.innerHTML = '';
  const ids = Object.keys(_speakerMap);
  if (!ids.length) {
    _gridEl.innerHTML = '<span style="color:#4b5563;font-size:12px;">No speakers detected</span>';
    return;
  }
  ids.forEach(id => _gridEl.appendChild(_buildCard(id)));
}

function _buildCard(id) {
  const spk = _speakerMap[id];
  const card = document.createElement('div');
  card.className = 'speaker-card' + (spk.muted ? ' speaker-card--muted' : '');
  card.dataset.speakerId = id;

  card.innerHTML = `
    <div class="speaker-card__header">
      <span class="speaker-card__swatch" style="background:${spk.color};"></span>
      <span class="speaker-card__label">${_esc(spk.label)}</span>
      <span class="speaker-card__id">${_esc(id)}</span>
    </div>
    <div class="speaker-card__vol-row">
      <span class="speaker-card__vol-lbl">Vol</span>
      <input class="speaker-card__vol" type="range" min="0" max="100"
             value="${Math.round(spk.volume * 100)}" step="1"
             aria-label="Volume for ${_esc(spk.label)}" />
      <span class="speaker-card__vol-val">${Math.round(spk.volume * 100)}%</span>
    </div>
    <div class="speaker-card__actions">
      <button class="mute-btn ${spk.muted ? 'active' : ''}"
              aria-pressed="${spk.muted}" aria-label="Mute ${_esc(spk.label)}">
        ${spk.muted ? '🔇 Muted' : '🔊 Mute'}
      </button>
      <button class="solo-btn ${spk.solo ? 'active' : ''}"
              aria-pressed="${spk.solo}" aria-label="Solo ${_esc(spk.label)}">
        ${spk.solo ? '★ Solo' : '☆ Solo'}
      </button>
      <button class="isolate-btn" aria-label="Isolate ${_esc(spk.label)}">
        🎯 Isolate
      </button>
      <button class="enroll-btn" aria-label="Enroll voiceprint from ${_esc(spk.label)}">
        🔑 Enroll
      </button>
    </div>
  `;

  // Volume slider
  const volSlider = card.querySelector('.speaker-card__vol');
  const volVal    = card.querySelector('.speaker-card__vol-val');
  volSlider.addEventListener('input', () => {
    const v = Number(volSlider.value) / 100;
    spk.volume = v;
    volVal.textContent = volSlider.value + '%';
    _dispatchVolumes('volume', id);
  });

  // Mute
  card.querySelector('.mute-btn').addEventListener('click', (e) => {
    spk.muted = !spk.muted;
    card.classList.toggle('speaker-card--muted', spk.muted);
    e.currentTarget.textContent = spk.muted ? '🔇 Muted' : '🔊 Mute';
    e.currentTarget.classList.toggle('active', spk.muted);
    e.currentTarget.setAttribute('aria-pressed', String(spk.muted));
    _dispatchVolumes('mute', id);
  });

  // Solo
  card.querySelector('.solo-btn').addEventListener('click', (e) => {
    const wasSolo = spk.solo;
    // Clear all solos first
    Object.values(_speakerMap).forEach(s => { s.solo = false; });
    _activeSoloId = null;
    if (!wasSolo) { spk.solo = true; _activeSoloId = id; }
    // Re-render all solo buttons
    document.querySelectorAll('.speaker-card').forEach(c => {
      const cid = c.dataset.speakerId;
      const btn = c.querySelector('.solo-btn');
      if (!btn) return;
      const active = _speakerMap[cid]?.solo;
      btn.classList.toggle('active', active);
      btn.textContent = active ? '★ Solo' : '☆ Solo';
      btn.setAttribute('aria-pressed', String(active));
    });
    _dispatchVolumes('solo', id);
    // Tell ML worker which speaker to isolate
    const w = _getMLWorker();
    if (w) {
      w.postMessage({ type: 'isolateSpeaker', payload: { speakerId: _activeSoloId } });
    }
  });

  // Isolate (hard isolate — zero all other volumes)
  card.querySelector('.isolate-btn').addEventListener('click', () => {
    Object.entries(_speakerMap).forEach(([sid, s]) => {
      s.volume = sid === id ? 1 : 0;
    });
    _rebuildGrid();
    _dispatchVolumes('volume', id);
    const w = _getMLWorker();
    if (w) w.postMessage({ type: 'isolateSpeaker', payload: { speakerId: id } });
  });

  // Enroll voiceprint from this speaker's segments
  card.querySelector('.enroll-btn').addEventListener('click', () => {
    if (_onEnrollFromSeg) _onEnrollFromSeg(id);
    const w = _getMLWorker();
    if (w) w.postMessage({ type: 'enrollFromDiarization', payload: { speakerId: id } });
  });

  return card;
}

// ── Internal helpers ──────────────────────────────────────────────────────────
function _dispatchVolumes(eventType, changedId) {
  const volumes = {};
  Object.entries(_speakerMap).forEach(([id, s]) => {
    if (s.muted) volumes[id] = 0;
    else if (_activeSoloId && _activeSoloId !== id) volumes[id] = 0;
    else volumes[id] = s.volume;
  });
  const w = _getMLWorker();
  if (w) w.postMessage({ type: 'speakerVolumes', payload: volumes });
  if (eventType === 'solo'   && _onSolo)   _onSolo(changedId, volumes);
  if (eventType === 'mute'   && _onMute)   _onMute(changedId, volumes);
  if (eventType === 'volume' && _onVolume) _onVolume(changedId, volumes);
}

function _esc(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
