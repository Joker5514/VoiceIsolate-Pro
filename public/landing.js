/**
 * VoiceIsolate Pro — Landing Page Controller (Layer 4: Presentation)
 *
 * Reference integration of the Stem-Split & Live-Mix pipeline:
 *
 *   fileInput ─► ingestFile() ─► MLWorker ('process') ─► loadStems()
 *                                                          │
 *   sliders ─► SliderUI ─► PlaybackMixer AudioParams ◄─────┘ (play/pause)
 *
 * No microphone. No inline scripts. Inference runs exactly once per file.
 */
'use strict';

import { ingestFile } from '/src/pipeline/FileIngestion.js';
import { PlaybackMixer } from '/src/pipeline/PlaybackMixer.js';
import { SliderUI } from '/src/presentation/SliderUI.js';
import { getModel } from '/src/core/ModelManifest.js';
import { MODEL_MANIFEST } from '/src/core/ModelManifest.js';

const $ = (id) => document.getElementById(id);

const ui = {
  fileInput: $('fileInput'),
  modelSelect: $('modelSelect'),
  processBtn: $('processBtn'),
  playBtn: $('playBtn'),
  pauseBtn: $('pauseBtn'),
  stopBtn: $('stopBtn'),
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  progress: $('inferenceProgress'),
  timeReadout: $('timeReadout'),
};

let mixer = null;
let sliderUI = null;
let worker = null;
let ingested = null;
let requestSeq = 0;

function setStatus(msg, cls = '') {
  ui.statusText.textContent = msg;
  ui.statusDot.className = `status-dot${cls ? ` ${cls}` : ''}`;
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ─── Worker lifecycle ────────────────────────────────────────────────────────

function getWorker() {
  if (worker) return worker;
  worker = new Worker('/src/workers/MLWorker.js');
  worker.postMessage({ type: 'init', manifest: Object.values(MODEL_MANIFEST) });
  worker.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'ready':
        console.log(`[VIP][landing] MLWorker ready (backend: ${msg.backend})`);
        break;
      case 'progress':
        ui.progress.hidden = false;
        ui.progress.value = msg.percent;
        setStatus(`Separating stems… ${msg.percent}%`, 'warn');
        break;
      case 'stems':
        onStems(msg);
        break;
      case 'error':
        setStatus(`Processing failed: ${msg.message}`, 'error');
        ui.progress.hidden = true;
        ui.processBtn.disabled = false;
        break;
      default:
        break;
    }
  });
  worker.addEventListener('error', (err) => {
    setStatus(`Worker error: ${err.message || 'unknown'}`, 'error');
    ui.processBtn.disabled = false;
  });
  return worker;
}

// ─── Slider value readouts ───────────────────────────────────────────────────

const READOUTS = [
  ['noiseReductionSlider', 'noiseReductionVal', (v) => `${v}%`],
  ['voiceLevelSlider', 'voiceLevelVal', (v) => `${v}%`],
  ['volumeSlider', 'volumeVal', (v) => `${v}%`],
  ['eqLowSlider', 'eqLowVal', (v) => `${v} dB`],
  ['eqHighSlider', 'eqHighVal', (v) => `${v} dB`],
];

function wireReadouts() {
  for (const [sliderId, valId, fmt] of READOUTS) {
    const slider = $(sliderId);
    const val = $(valId);
    if (!slider || !val) continue;
    slider.addEventListener('input', () => { val.textContent = fmt(slider.value); });
  }
}

// ─── Pipeline glue ───────────────────────────────────────────────────────────

async function onFileChosen() {
  const file = ui.fileInput.files && ui.fileInput.files[0];
  if (!file) return;
  ui.processBtn.disabled = true;
  try {
    setStatus(`Decoding “${file.name}”…`, 'warn');
    ingested = await ingestFile(file, {
      onProgress: (stage) => {
        if (stage === 'resampling') setStatus('Resampling to 48 kHz…', 'warn');
      },
    });
    setStatus(`Ready: ${ingested.sourceName} · ${fmtTime(ingested.duration)} · ${ingested.numberOfChannels} ch`, '');
    ui.processBtn.disabled = false;
  } catch (err) {
    console.error('[VIP][landing] ingestion failed:', err);
    setStatus(err.message, 'error');
    ingested = null;
  }
}

function onProcess() {
  if (!ingested) return;
  const modelId = getModel(ui.modelSelect.value).id;
  ui.processBtn.disabled = true;
  ui.progress.hidden = false;
  ui.progress.value = 0;
  setStatus('Separating stems… 0%', 'warn');

  // Channel copies are transferred — keep our reference for re-processing.
  const channelData = ingested.channelData.map((c) => new Float32Array(c));
  getWorker().postMessage(
    { type: 'process', requestId: ++requestSeq, modelId, channelData, sampleRate: ingested.sampleRate },
    channelData.map((c) => c.buffer)
  );
}

function onStems({ requestId, clean, noise, sampleRate, passthrough }) {
  if (requestId !== requestSeq) return; // stale response
  ui.progress.hidden = true;
  ui.processBtn.disabled = false;

  if (!mixer) {
    mixer = new PlaybackMixer();
    sliderUI = new SliderUI(mixer);
    sliderUI.bind();
  }
  mixer.loadStems(clean, noise, sampleRate);

  for (const btn of [ui.playBtn, ui.pauseBtn, ui.stopBtn]) btn.disabled = false;
  setStatus(
    passthrough
      ? 'Model unavailable — passthrough stems loaded (original audio). Check that /app/models is being served.'
      : 'Stems ready — press Play and mix in real time.',
    passthrough ? 'warn' : 'active'
  );
}

function wireTransport() {
  ui.playBtn.addEventListener('click', async () => {
    try { await mixer.play(); } catch (err) { setStatus(err.message, 'error'); }
  });
  ui.pauseBtn.addEventListener('click', () => mixer && mixer.pause());
  ui.stopBtn.addEventListener('click', () => mixer && mixer.stop());

  setInterval(() => {
    if (!mixer) return;
    ui.timeReadout.textContent = `${fmtTime(mixer.currentTime())} / ${fmtTime(mixer.duration())}`;
  }, 250);
}

// ─── Boot ────────────────────────────────────────────────────────────────────

ui.fileInput.addEventListener('change', onFileChosen);
ui.processBtn.addEventListener('click', onProcess);
wireReadouts();
wireTransport();
setStatus('Idle — choose a file to begin', '');
