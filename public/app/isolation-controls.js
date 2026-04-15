/**
 * public/app/isolation-controls.js
 * VoiceIsolate Pro — Threads from Space v8
 *
 * Speaker Isolation Controls Panel
 * ─────────────────────────────────────────────────────────────────
 * Dynamically builds per-speaker cards + global isolation controls.
 * Wires into the existing setParam() / App.mlWorker pattern.
 *
 * DOM dependencies:
 *   #isolation-controls-root    root container (emptied + rebuilt on diarization update)
 *   #isolation-method-select    <select> classical | ml | hybrid
 *   #isolation-confidence       <input type=range>
 *   #isolation-bg-volume        <input type=range>
 *   #enroll-voiceprint-btn      <button>
 *   #clear-voiceprint-btn       <button>
 *   #voiceprint-status          <span>
 *
 * Dispatches / listens:
 *   CustomEvent 'diarization:speakerSelected' (from diarization-timeline.js)
 *   Calls setSpeakerVolume / setSpeakerMute / setSpeakerSolo from diarization-timeline.js
 */

'use strict';

import {
  setSpeakerVolume,
  setSpeakerMute,
  setSpeakerSolo,
} from './diarization-timeline.js';

// ─────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────
const IsolationControls = {
  mlWorker:      null,
  audioContext:  null,
  mediaStream:   null,  // for voiceprint enrollment recording
  enrollRecorder: null,
  enrollChunks:  [],
  activeSpeaker: null,
  speakers:      {},   // mirror of Timeline.speakers
};

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Initialize isolation controls.
 * @param {{ mlWorker, audioContext, mediaStream }} opts
 */
export function initIsolationControls({ mlWorker, audioContext, mediaStream } = {}) {
  IsolationControls.mlWorker     = mlWorker;
  IsolationControls.audioContext = audioContext;
  IsolationControls.mediaStream  = mediaStream;

  _bindGlobalControls();
  _bindVoiceprintButtons();
  _bindSpeakerSelectedEvent();

  console.info('[IsolationControls] Initialized');
}

/**
 * Rebuild speaker cards when new diarization data arrives.
 * @param {{ [speakerId]: { label, color, volume, muted, solo } }} speakers
 */
export function updateSpeakerCards(speakers) {
  IsolationControls.speakers = speakers;
  _renderSpeakerCards(speakers);
}

/**
 * Highlight the active (isolated) speaker card.
 */
export function setActiveSpeakerCard(speakerId) {
  IsolationControls.activeSpeaker = speakerId;
  document.querySelectorAll('.speaker-card').forEach(card => {
    const isActive = card.dataset.speakerId === speakerId || speakerId === null;
    card.classList.toggle('speaker-card--active', isActive);
    card.classList.toggle('speaker-card--muted',  !isActive && speakerId !== null);
  });
}

// ─────────────────────────────────────────────
// Speaker cards renderer
// ─────────────────────────────────────────────

function _renderSpeakerCards(speakers) {
  const root = document.getElementById('isolation-controls-root');
  if (!root) return;

  // Keep global controls, only replace the cards section
  let cardsSection = root.querySelector('#speaker-cards-section');
  if (!cardsSection) {
    cardsSection = document.createElement('div');
    cardsSection.id = 'speaker-cards-section';
    cardsSection.className = 'speaker-cards-grid';
    root.appendChild(cardsSection);
  }
  cardsSection.innerHTML = '';

  if (Object.keys(speakers).length === 0) {
    cardsSection.innerHTML = `
      <div class="isolation-empty">
        <span class="isolation-empty__icon">🎙</span>
        <p>Process audio to detect speakers</p>
      </div>`;
    return;
  }

  Object.entries(speakers).forEach(([speakerId, spk]) => {
    const card = _buildSpeakerCard(speakerId, spk);
    cardsSection.appendChild(card);
  });
}

function _buildSpeakerCard(speakerId, spk) {
  const card = document.createElement('div');
  card.className = 'speaker-card';
  card.dataset.speakerId = speakerId;

  const volPct = Math.round(spk.volume * 100);

  card.innerHTML = `
    <div class="speaker-card__header">
      <span class="speaker-card__swatch" style="background:${spk.color}"></span>
      <span class="speaker-card__label">${_escHtml(spk.label)}</span>
      <span class="speaker-card__id">#${speakerId}</span>
    </div>

    <div class="speaker-card__controls">
      <label class="speaker-card__vol-label">Vol</label>
      <input
        type="range" min="0" max="100" value="${volPct}"
        class="vip-slider speaker-card__vol"
        data-speaker-id="${speakerId}"
        aria-label="Speaker ${speakerId} volume"
      />
      <span class="speaker-card__vol-readout">${volPct}%</span>
    </div>

    <div class="speaker-card__actions">
      <button
        class="vip-btn vip-btn--sm speaker-card__mute ${spk.muted ? 'active' : ''}"
        data-speaker-id="${speakerId}"
        title="Mute speaker"
        aria-pressed="${spk.muted}"
      >${spk.muted ? '🔇' : '🔊'}</button>

      <button
        class="vip-btn vip-btn--sm speaker-card__solo ${spk.solo ? 'active' : ''}"
        data-speaker-id="${speakerId}"
        title="Solo / isolate this speaker"
        aria-pressed="${spk.solo}"
      >Solo</button>

      <button
        class="vip-btn vip-btn--sm speaker-card__enroll-ref"
        data-speaker-id="${speakerId}"
        title="Use this speaker as voiceprint reference"
      >🎯 Ref</button>
    </div>`;

  // Volume slider
  const volSlider = card.querySelector('.speaker-card__vol');
  const volReadout = card.querySelector('.speaker-card__vol-readout');
  volSlider.addEventListener('input', () => {
    const v = Number(volSlider.value) / 100;
    volReadout.textContent = `${volSlider.value}%`;
    setSpeakerVolume(speakerId, v);
  });

  // Mute button
  card.querySelector('.speaker-card__mute').addEventListener('click', (e) => {
    const btn   = e.currentTarget;
    const muted = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(muted));
    btn.textContent = muted ? '🔇' : '🔊';
    btn.classList.toggle('active', muted);
    setSpeakerMute(speakerId, muted);
  });

  // Solo button
  card.querySelector('.speaker-card__solo').addEventListener('click', () => {
    setSpeakerSolo(speakerId);
    // UI updated by setActiveSpeakerCard() called via 'diarization:speakerSelected'
  });

  // Reference voiceprint button
  card.querySelector('.speaker-card__enroll-ref').addEventListener('click', () => {
    _enrollFromSegments(speakerId);
  });

  return card;
}

// ─────────────────────────────────────────────
// Global isolation controls
// ─────────────────────────────────────────────

function _bindGlobalControls() {
  // Isolation method
  const methodSel = document.getElementById('isolation-method-select');
  methodSel?.addEventListener('change', () => {
    IsolationControls.mlWorker?.postMessage({
      type: 'param',
      payload: { key: 'isolationMethod', value: methodSel.value },
    });
  });

  // Confidence threshold
  const confSlider   = document.getElementById('isolation-confidence');
  const confReadout  = document.getElementById('isolation-confidence-readout');
  confSlider?.addEventListener('input', () => {
    const v = Number(confSlider.value) / 100;
    if (confReadout) confReadout.textContent = confSlider.value + '%';
    IsolationControls.mlWorker?.postMessage({
      type: 'param',
      payload: { key: 'ecapaSimilarityThreshold', value: v },
    });
  });

  // Background volume
  const bgSlider  = document.getElementById('isolation-bg-volume');
  const bgReadout = document.getElementById('isolation-bg-readout');
  bgSlider?.addEventListener('input', () => {
    const v = Number(bgSlider.value) / 100;
    if (bgReadout) bgReadout.textContent = bgSlider.value + '%';
    IsolationControls.mlWorker?.postMessage({
      type: 'param',
      payload: { key: 'backgroundVolume', value: v },
    });
  });

  // Mask refinement toggle
  document.getElementById('isolation-mask-refine')?.addEventListener('change', (e) => {
    IsolationControls.mlWorker?.postMessage({
      type: 'param',
      payload: { key: 'maskRefinement', value: e.target.checked },
    });
  });
}

// ─────────────────────────────────────────────
// Voiceprint enrollment
// ─────────────────────────────────────────────

function _bindVoiceprintButtons() {
  const enrollBtn = document.getElementById('enroll-voiceprint-btn');
  const clearBtn  = document.getElementById('clear-voiceprint-btn');
  const status    = document.getElementById('voiceprint-status');

  enrollBtn?.addEventListener('click', async () => {
    if (!IsolationControls.mediaStream) {
      _setVoiceprintStatus('No mic stream — start Live mode first', 'warn');
      return;
    }
    await _recordVoiceprint(enrollBtn, status);
  });

  clearBtn?.addEventListener('click', () => {
    IsolationControls.mlWorker?.postMessage({ type: 'clearVoiceprint' });
    _setVoiceprintStatus('Voiceprint cleared', 'idle');
  });
}

async function _recordVoiceprint(btn, statusEl) {
  const stream  = IsolationControls.mediaStream;
  const DURATION = 5000; // 5 seconds

  _setVoiceprintStatus('Recording 5s…', 'recording');
  btn.disabled = true;

  try {
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    const chunks   = [];

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.start(100);

    await new Promise(r => setTimeout(r, DURATION));
    recorder.stop();

    await new Promise(r => { recorder.onstop = r; });

    const blob   = new Blob(chunks, { type: 'audio/webm' });
    const arrBuf = await blob.arrayBuffer();
    const decoded = await IsolationControls.audioContext.decodeAudioData(arrBuf);
    const pcm     = decoded.getChannelData(0);

    IsolationControls.mlWorker?.postMessage({ type: 'enrollVoiceprint', payload: { pcm } }, [pcm.buffer]);
    _setVoiceprintStatus('Enrolled ✓', 'ready');
  } catch (err) {
    console.error('[IsolationControls] Voiceprint enrollment failed', err);
    _setVoiceprintStatus(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
}

/**
 * Extract PCM from already-recorded segments of a specific speaker
 * and send as voiceprint enrollment material.
 */
async function _enrollFromSegments(speakerId) {
  const status = document.getElementById('voiceprint-status');
  _setVoiceprintStatus(`Extracting voiceprint for ${speakerId}…`, 'recording');

  // Signal ml-worker to extract embedding from existing diarization segments
  IsolationControls.mlWorker?.postMessage({
    type: 'enrollFromDiarization',
    payload: { speakerId },
  });
  // Status will be updated when worker responds with 'voiceprintEnrolled'
}

function _setVoiceprintStatus(msg, state = 'idle') {
  const el = document.getElementById('voiceprint-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `voiceprint-status voiceprint-status--${state}`;
}

// ─────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────

function _bindSpeakerSelectedEvent() {
  document.addEventListener('diarization:speakerSelected', (e) => {
    setActiveSpeakerCard(e.detail?.speakerId ?? null);
  });
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
