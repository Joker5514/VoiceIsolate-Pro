/**
 * VoiceIsolate Pro — Target-speaker enrollment UI (Layer 4)
 *
 * Waveform region enroll → local mel voiceprint → soft gain on clean stem.
 * Does not call cloud APIs. Does not re-run ONNX separation (post-process only).
 */
'use strict';

import {
  enrollFromRange,
  buildTargetGainCurve,
  applyGainToChannels,
  matchEmbeddingToDiarization,
} from '../core/TargetSpeaker.js';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container
 * @param {() => { channelData: Float32Array[], sampleRate: number }|null} opts.getAudio
 * @param {(channels: Float32Array[], sampleRate: number) => void|Promise<void>} opts.onIsolated
 * @param {(msg: string, kind?: string) => void} [opts.notify]
 * @param {() => Array<{speakerId:string,start:number,end:number}>|null} [opts.getDiarizationSegments]
 */
export function mountTargetSpeakerUI(opts) {
  const { container, getAudio, onIsolated, notify = () => {}, getDiarizationSegments } = opts;
  if (!container) throw new TypeError('[VIP][TargetSpeakerUI] container required');

  container.textContent = '';
  container.classList.add('target-speaker-panel');

  const title = el('h3', 'target-speaker-title', 'Target speaker (local)');
  const hint = el(
    'p',
    'hint',
    'Select a short clean speech region (seconds), Enroll, then Isolate. '
    + 'Uses on-device mel-band voiceprint (not ECAPA-TDNN yet) — no audio leaves the device. '
    + 'When diarization segments are available they are fused into the gain curve.',
  );

  const row = el('div', 'target-speaker-row');
  const startLab = el('label', '', 'Start (s)');
  const startIn = inputNum('tsStart', 0, 0.1);
  const endLab = el('label', '', 'End (s)');
  const endIn = inputNum('tsEnd', 2, 0.1);
  const enrollBtn = button('Enroll target', 'btn btn-outline');
  const applyBtn = button('Isolate target', 'btn');
  applyBtn.disabled = true;
  const status = el('p', 'target-speaker-status hint', 'No enrollment yet.');

  row.append(startLab, startIn, endLab, endIn, enrollBtn, applyBtn);
  container.append(title, hint, row, status);

  /** @type {Float32Array|null} */
  let embedding = null;

  enrollBtn.addEventListener('click', () => {
    const audio = getAudio();
    if (!audio?.channelData?.[0]) {
      notify('Load and process audio first', 'warn');
      status.textContent = 'No audio loaded.';
      return;
    }
    const mono = audio.channelData[0];
    const sr = audio.sampleRate || 48000;
    const range = {
      startSec: Number(startIn.value) || 0,
      endSec: Number(endIn.value) || 0,
    };
    const result = enrollFromRange(mono, sr, range);
    if (!result.ok) {
      embedding = null;
      applyBtn.disabled = true;
      status.textContent = result.reason;
      notify(result.reason, 'error');
      return;
    }
    embedding = result.embedding;
    applyBtn.disabled = false;
    status.textContent = `Enrolled ${range.startSec.toFixed(2)}–${range.endSec.toFixed(2)}s · `
      + `${result.meta.dims}-D local voiceprint · speech ${(result.meta.speechRatio * 100).toFixed(0)}%`;
    notify('Target speaker enrolled (local only)', 'ok');
  });

  applyBtn.addEventListener('click', async () => {
    const audio = getAudio();
    if (!audio?.channelData?.[0] || !embedding) {
      notify('Enroll a target first', 'warn');
      return;
    }
    const mono = audio.channelData[0];
    const sr = audio.sampleRate || 48000;
    status.textContent = 'Building target gain (local)…';
    const segs = typeof getDiarizationSegments === 'function'
      ? (getDiarizationSegments() || null)
      : null;
    let targetSpeakerId = null;
    let matchNote = '';
    if (segs && segs.length) {
      const match = matchEmbeddingToDiarization(mono, sr, embedding, segs);
      if (match && match.similarity >= 0.25) {
        targetSpeakerId = match.speakerId;
        matchNote = ` · diarization cluster ${match.speakerId} (sim ${match.similarity.toFixed(2)})`;
      }
    }
    const gain = buildTargetGainCurve(mono, sr, embedding, {
      diarizationSegments: segs || undefined,
      targetSpeakerId: targetSpeakerId || undefined,
      smoothMs: 15,
    });
    const isolated = applyGainToChannels(audio.channelData, gain);
    await onIsolated(isolated, sr);
    status.textContent = `Target isolation applied (mel voiceprint soft gain${matchNote}).`;
    notify('Target isolation applied locally', 'ok');
  });

  return {
    getEmbedding: () => embedding,
    clear() {
      embedding = null;
      applyBtn.disabled = true;
      status.textContent = 'No enrollment yet.';
    },
  };
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
}

function inputNum(id, val, step) {
  const n = document.createElement('input');
  n.type = 'number';
  n.id = id;
  n.value = String(val);
  n.step = String(step);
  n.min = '0';
  n.className = 'target-speaker-input';
  return n;
}

function button(label, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  return b;
}

export default { mountTargetSpeakerUI };
