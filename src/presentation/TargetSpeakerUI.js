/**
 * VoiceIsolate Pro — Target-speaker enrollment UI (Layer 4)
 *
 * Friendly step-by-step enrollment → local mel voiceprint → soft gain on clean stem.
 * Shared by Engineer Mode, Landing (when mounted), Capacitor Android, and Electron
 * (same public/src module after sync:src).
 *
 * Does not call cloud APIs. Does not re-run ONNX separation (post-process only).
 */
'use strict';

import {
  enrollFromRange,
  buildTargetGainCurve,
  applyGainToChannels,
  matchEmbeddingToDiarization,
  MIN_ENROLL_SEC,
  MAX_ENROLL_SEC,
} from '../core/TargetSpeaker.js';

const STYLE_ID = 'vip-target-speaker-styles';

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container
 * @param {() => { channelData: Float32Array[], sampleRate: number }|null} opts.getAudio
 * @param {(channels: Float32Array[], sampleRate: number) => void|Promise<void>} opts.onIsolated
 * @param {(msg: string, kind?: string) => void} [opts.notify]
 * @param {() => Array<{speakerId:string,start:number,end:number}>|null} [opts.getDiarizationSegments]
 * @param {() => number|null} [opts.getDurationSec] optional full clip duration for helpers
 * @param {() => number|null} [opts.getPlayheadSec] optional playhead for “use current time”
 */
export function mountTargetSpeakerUI(opts) {
  const {
    container,
    getAudio,
    onIsolated,
    notify = () => {},
    getDiarizationSegments,
    getDurationSec,
    getPlayheadSec,
  } = opts;
  if (!container) throw new TypeError('[VIP][TargetSpeakerUI] container required');

  ensureStyles();
  container.textContent = '';
  container.classList.add('target-speaker-panel', 'vip-ts-panel');

  // ── Header ──────────────────────────────────────────────────────────────
  const header = el('header', 'vip-ts-header');
  const title = el('h3', 'target-speaker-title vip-ts-title', 'Focus on one voice');
  title.id = 'vip-ts-title';
  const badge = el('span', 'vip-ts-badge', '100% on this device');
  header.append(title, badge);

  const lead = el(
    'p',
    'vip-ts-lead',
    'Pick a short stretch where only the person you care about is talking, enroll that voiceprint, '
    + 'then isolate so other talkers and background speech are turned down. '
    + 'Nothing is uploaded — processing stays on your device.',
  );

  // ── How to use (always visible steps) ───────────────────────────────────
  const steps = el('ol', 'vip-ts-steps');
  steps.setAttribute('aria-label', 'How to enroll a target voice');
  const stepItems = [
    {
      n: '1',
      t: 'Load & prepare audio',
      d: 'Upload a file, then Process / Separate stems so a clean voice stem is available.',
    },
    {
      n: '2',
      t: 'Mark a clean speech region',
      d: `Enter start and end times (seconds) of ${MIN_ENROLL_SEC}–${MAX_ENROLL_SEC}s where only your target person speaks clearly.`,
    },
    {
      n: '3',
      t: 'Enroll',
      d: 'Creates a local voiceprint from that region (mel-band embedding — not cloud AI).',
    },
    {
      n: '4',
      t: 'Isolate target',
      d: 'Softly attenuates non-matching speech. Uses diarization clusters when available. Does not re-run ML separation.',
    },
  ];
  for (const s of stepItems) {
    const li = el('li', 'vip-ts-step');
    const num = el('span', 'vip-ts-step-num', s.n);
    num.setAttribute('aria-hidden', 'true');
    const body = el('div', 'vip-ts-step-body');
    body.append(el('strong', 'vip-ts-step-title', s.t), el('p', 'vip-ts-step-desc', s.d));
    li.append(num, body);
    steps.appendChild(li);
  }

  // ── Tips details ────────────────────────────────────────────────────────
  const tips = document.createElement('details');
  tips.className = 'vip-ts-tips';
  const tipsSum = document.createElement('summary');
  tipsSum.textContent = 'Tips for best results';
  tips.appendChild(tipsSum);
  const tipsList = el('ul', 'vip-ts-tips-list');
  [
    'Prefer a section with little overlap from other speakers.',
    'Avoid loud noise, music, or reverb in the enrollment clip.',
    '1–3 seconds of clear speech is usually enough; longer is fine up to the max.',
    'After Isolate, use Play to A/B; re-enroll if you picked a weak region.',
    'Speaker mute/solo cards (when diarization runs) still work for live balance.',
  ].forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    tipsList.appendChild(li);
  });
  tips.appendChild(tipsList);

  // ── Region form ─────────────────────────────────────────────────────────
  const form = el('div', 'vip-ts-form');
  form.setAttribute('role', 'group');
  form.setAttribute('aria-labelledby', 'vip-ts-title');

  const regionHead = el('div', 'vip-ts-form-head');
  regionHead.append(
    el('h4', 'vip-ts-form-title', 'Enrollment region'),
    el('p', 'vip-ts-form-sub', 'Times are in seconds from the start of the loaded audio.'),
  );

  const fields = el('div', 'vip-ts-fields');
  const startWrap = fieldWrap('Start (seconds)', 'tsStart', 0, 0.1);
  const endWrap = fieldWrap('End (seconds)', 'tsEnd', 2, 0.1);
  const startIn = startWrap.input;
  const endIn = endWrap.input;
  fields.append(startWrap.wrap, endWrap.wrap);

  const durationReadout = el('p', 'vip-ts-duration', 'Selected length: 2.0 s');
  durationReadout.setAttribute('aria-live', 'polite');

  const quick = el('div', 'vip-ts-quick');
  quick.setAttribute('role', 'group');
  quick.setAttribute('aria-label', 'Quick region helpers');
  const qLabel = el('span', 'vip-ts-quick-label', 'Quick fill:');
  const qFirst2 = button('First 2 s', 'btn btn-outline vip-ts-chip');
  const qFirst3 = button('First 3 s', 'btn btn-outline vip-ts-chip');
  const qAroundPlay = button('Around playhead', 'btn btn-outline vip-ts-chip');
  const qFullClip = button('Clip duration', 'btn btn-outline vip-ts-chip');
  qAroundPlay.title = 'Set a 2 s window centered on the current play position (if available)';
  qFullClip.title = 'Show total length of loaded audio in the end field (does not enroll full clip)';
  quick.append(qLabel, qFirst2, qFirst3, qAroundPlay, qFullClip);

  const actions = el('div', 'vip-ts-actions');
  const enrollBtn = button('1 · Enroll this voice', 'btn btn-outline vip-ts-enroll');
  enrollBtn.setAttribute('aria-describedby', 'vip-ts-status');
  const applyBtn = button('2 · Isolate target speaker', 'btn vip-ts-apply');
  applyBtn.disabled = true;
  applyBtn.setAttribute('aria-describedby', 'vip-ts-status');
  const clearBtn = button('Clear enrollment', 'btn btn-outline vip-ts-clear');
  clearBtn.disabled = true;
  actions.append(enrollBtn, applyBtn, clearBtn);

  const status = el('p', 'target-speaker-status vip-ts-status hint', 'No enrollment yet — mark a region and click Enroll.');
  status.id = 'vip-ts-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const privacy = el(
    'p',
    'vip-ts-privacy hint',
    'Privacy: voiceprint stays in this browser session only (mel-band local embedding). '
    + 'ECAPA-TDNN ONNX is not required for this workflow.',
  );

  form.append(regionHead, fields, durationReadout, quick, actions, status, privacy);
  container.append(header, lead, steps, tips, form);

  /** @type {Float32Array|null} */
  let embedding = null;
  /** @type {{ startSec: number, endSec: number, speechRatio?: number, dims?: number }|null} */
  let enrollMeta = null;

  const updateDuration = () => {
    const a = Number(startIn.value) || 0;
    const b = Number(endIn.value) || 0;
    const d = Math.max(0, b - a);
    let note = `Selected length: ${d.toFixed(1)} s`;
    if (d > 0 && d < MIN_ENROLL_SEC) note += ` · need at least ${MIN_ENROLL_SEC} s`;
    if (d > MAX_ENROLL_SEC) note += ` · max ${MAX_ENROLL_SEC} s`;
    const clip = typeof getDurationSec === 'function' ? getDurationSec() : null;
    if (Number.isFinite(clip) && clip > 0) note += ` · file ≈ ${clip.toFixed(1)} s`;
    durationReadout.textContent = note;
  };
  startIn.addEventListener('input', updateDuration);
  endIn.addEventListener('input', updateDuration);
  updateDuration();

  qFirst2.addEventListener('click', () => {
    startIn.value = '0';
    endIn.value = '2';
    updateDuration();
  });
  qFirst3.addEventListener('click', () => {
    startIn.value = '0';
    endIn.value = '3';
    updateDuration();
  });
  qAroundPlay.addEventListener('click', () => {
    const t = typeof getPlayheadSec === 'function' ? getPlayheadSec() : null;
    if (!Number.isFinite(t) || t == null) {
      notify('Play or seek first so a playhead time is available', 'warn');
      status.textContent = 'No playhead yet — press Play or move the seek bar, then try again.';
      return;
    }
    const half = 1;
    const a = Math.max(0, t - half);
    const b = a + 2;
    startIn.value = String(round1(a));
    endIn.value = String(round1(b));
    updateDuration();
    status.textContent = `Region set around ${t.toFixed(1)} s playhead.`;
  });
  qFullClip.addEventListener('click', () => {
    const clip = typeof getDurationSec === 'function' ? getDurationSec() : null;
    if (!Number.isFinite(clip) || !clip) {
      const audio = getAudio();
      if (audio?.channelData?.[0] && audio.sampleRate) {
        const d = audio.channelData[0].length / audio.sampleRate;
        endIn.value = String(round1(Math.min(d, MAX_ENROLL_SEC)));
        startIn.value = '0';
        updateDuration();
        return;
      }
      notify('Load audio first', 'warn');
      return;
    }
    startIn.value = '0';
    endIn.value = String(round1(Math.min(clip, MAX_ENROLL_SEC)));
    updateDuration();
    status.textContent = `End set to min(file length, ${MAX_ENROLL_SEC} s). Prefer a short clean speech slice.`;
  });

  enrollBtn.addEventListener('click', () => {
    const audio = getAudio();
    if (!audio?.channelData?.[0]) {
      notify('Load and process audio first', 'warn');
      status.textContent = 'No audio loaded. Upload a file and Process / Separate stems first.';
      return;
    }
    const mono = audio.channelData[0];
    const sr = audio.sampleRate || 48000;
    const range = {
      startSec: Number(startIn.value) || 0,
      endSec: Number(endIn.value) || 0,
    };
    if (range.endSec <= range.startSec) {
      status.textContent = 'End time must be after start time.';
      notify('Invalid region: end must be after start', 'error');
      return;
    }
    const result = enrollFromRange(mono, sr, range);
    if (!result.ok) {
      embedding = null;
      enrollMeta = null;
      applyBtn.disabled = true;
      clearBtn.disabled = true;
      status.textContent = result.reason;
      status.classList.add('vip-ts-status--error');
      status.classList.remove('vip-ts-status--ok');
      notify(result.reason, 'error');
      return;
    }
    embedding = result.embedding;
    enrollMeta = {
      startSec: range.startSec,
      endSec: range.endSec,
      speechRatio: result.meta.speechRatio,
      dims: result.meta.dims,
    };
    applyBtn.disabled = false;
    clearBtn.disabled = false;
    status.classList.remove('vip-ts-status--error');
    status.classList.add('vip-ts-status--ok');
    status.textContent = `Enrolled ${range.startSec.toFixed(2)}–${range.endSec.toFixed(2)} s · `
      + `${result.meta.dims}-D local voiceprint · speech ~${(result.meta.speechRatio * 100).toFixed(0)}%. `
      + 'Next: click Isolate target speaker.';
    notify('Target speaker enrolled (local only)', 'ok');
  });

  applyBtn.addEventListener('click', async () => {
    const audio = getAudio();
    if (!audio?.channelData?.[0] || !embedding) {
      notify('Enroll a target first', 'warn');
      status.textContent = 'Enroll a voice region before isolating.';
      return;
    }
    const mono = audio.channelData[0];
    const sr = audio.sampleRate || 48000;
    applyBtn.disabled = true;
    status.textContent = 'Building target gain (local)…';
    status.classList.remove('vip-ts-status--error');
    try {
      const segs = typeof getDiarizationSegments === 'function'
        ? (getDiarizationSegments() || null)
        : null;
      let targetSpeakerId = null;
      let matchNote = '';
      if (segs && segs.length) {
        const match = matchEmbeddingToDiarization(mono, sr, embedding, segs);
        if (match && match.similarity >= 0.25) {
          targetSpeakerId = match.speakerId;
          matchNote = ` · matched diarization speaker “${match.speakerId}” (sim ${match.similarity.toFixed(2)})`;
        } else {
          matchNote = ' · no strong diarization match (voiceprint-only gain)';
        }
      }
      const gain = buildTargetGainCurve(mono, sr, embedding, {
        diarizationSegments: segs || undefined,
        targetSpeakerId: targetSpeakerId || undefined,
        smoothMs: 15,
      });
      const isolated = applyGainToChannels(audio.channelData, gain);
      await onIsolated(isolated, sr);
      status.classList.add('vip-ts-status--ok');
      status.textContent = `Isolation applied${matchNote}. Press Play to listen. Re-enroll if the wrong voice was kept.`;
      notify('Target isolation applied locally', 'ok');
    } catch (err) {
      status.classList.add('vip-ts-status--error');
      status.textContent = `Isolation failed: ${err?.message || err}`;
      notify(status.textContent, 'error');
    } finally {
      applyBtn.disabled = !embedding;
    }
  });

  clearBtn.addEventListener('click', () => {
    embedding = null;
    enrollMeta = null;
    applyBtn.disabled = true;
    clearBtn.disabled = true;
    status.classList.remove('vip-ts-status--ok', 'vip-ts-status--error');
    status.textContent = 'Enrollment cleared. Mark a region and enroll again when ready.';
    notify('Target enrollment cleared', 'info');
  });

  return {
    getEmbedding: () => embedding,
    getEnrollMeta: () => enrollMeta,
    clear() {
      embedding = null;
      enrollMeta = null;
      applyBtn.disabled = true;
      clearBtn.disabled = true;
      status.classList.remove('vip-ts-status--ok', 'vip-ts-status--error');
      status.textContent = 'No enrollment yet — mark a region and click Enroll.';
    },
  };
}

function fieldWrap(labelText, id, val, step) {
  const wrap = el('div', 'vip-ts-field');
  const lab = document.createElement('label');
  lab.htmlFor = id;
  lab.className = 'vip-ts-label';
  lab.textContent = labelText;
  const input = inputNum(id, val, step);
  input.setAttribute('aria-label', labelText);
  wrap.append(lab, input);
  return { wrap, input };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null && text !== '') n.textContent = text;
  return n;
}

function inputNum(id, val, step) {
  const n = document.createElement('input');
  n.type = 'number';
  n.id = id;
  n.value = String(val);
  n.step = String(step);
  n.min = '0';
  n.className = 'target-speaker-input vip-ts-input';
  n.inputMode = 'decimal';
  return n;
}

function button(label, cls) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  return b;
}

function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.vip-ts-panel {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  max-width: 42rem;
}
.vip-ts-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
}
.vip-ts-title {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 650;
  letter-spacing: -0.01em;
}
.vip-ts-badge {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 0.2rem 0.5rem;
  border-radius: 999px;
  background: color-mix(in srgb, #22c55e 18%, transparent);
  color: #86efac;
  border: 1px solid color-mix(in srgb, #22c55e 35%, transparent);
}
.vip-ts-lead {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.45;
  opacity: 0.9;
}
.vip-ts-steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.55rem;
}
.vip-ts-step {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.65rem;
  align-items: start;
  padding: 0.55rem 0.7rem;
  border-radius: 10px;
  background: color-mix(in srgb, currentColor 6%, transparent);
  border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
}
.vip-ts-step-num {
  display: inline-flex;
  width: 1.55rem;
  height: 1.55rem;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  font-size: 0.8rem;
  font-weight: 700;
  background: color-mix(in srgb, #38bdf8 25%, transparent);
  color: #7dd3fc;
  flex-shrink: 0;
}
.vip-ts-step-title {
  display: block;
  font-size: 0.88rem;
  margin-bottom: 0.15rem;
}
.vip-ts-step-desc {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.4;
  opacity: 0.85;
}
.vip-ts-tips {
  font-size: 0.85rem;
  border-radius: 10px;
  border: 1px solid color-mix(in srgb, currentColor 12%, transparent);
  padding: 0.35rem 0.75rem;
}
.vip-ts-tips summary {
  cursor: pointer;
  font-weight: 600;
  padding: 0.35rem 0;
}
.vip-ts-tips-list {
  margin: 0.25rem 0 0.5rem 1.1rem;
  padding: 0;
  line-height: 1.45;
  opacity: 0.9;
}
.vip-ts-form {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  padding: 0.85rem;
  border-radius: 12px;
  border: 1px solid color-mix(in srgb, currentColor 14%, transparent);
  background: color-mix(in srgb, currentColor 4%, transparent);
}
.vip-ts-form-head { margin-bottom: 0.15rem; }
.vip-ts-form-title {
  margin: 0 0 0.2rem;
  font-size: 0.95rem;
}
.vip-ts-form-sub {
  margin: 0;
  font-size: 0.78rem;
  opacity: 0.75;
}
.vip-ts-fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.65rem;
}
@media (max-width: 520px) {
  .vip-ts-fields { grid-template-columns: 1fr; }
}
.vip-ts-field {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.vip-ts-label {
  font-size: 0.78rem;
  font-weight: 600;
  opacity: 0.9;
}
.vip-ts-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.45rem 0.55rem;
  border-radius: 8px;
  border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  background: color-mix(in srgb, #000 25%, transparent);
  color: inherit;
  font-size: 0.95rem;
}
.vip-ts-duration {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.85;
}
.vip-ts-quick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}
.vip-ts-quick-label {
  font-size: 0.75rem;
  font-weight: 600;
  opacity: 0.8;
  margin-right: 0.15rem;
}
.vip-ts-chip {
  font-size: 0.75rem !important;
  padding: 0.25rem 0.55rem !important;
  border-radius: 999px !important;
}
.vip-ts-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.15rem;
}
.vip-ts-actions .btn {
  flex: 1 1 auto;
  min-width: 8rem;
}
.vip-ts-apply:disabled,
.vip-ts-clear:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.vip-ts-status {
  margin: 0.15rem 0 0;
  font-size: 0.85rem;
  line-height: 1.4;
  padding: 0.5rem 0.65rem;
  border-radius: 8px;
  background: color-mix(in srgb, currentColor 5%, transparent);
}
.vip-ts-status--ok {
  border-left: 3px solid #22c55e;
}
.vip-ts-status--error {
  border-left: 3px solid #ef4444;
}
.vip-ts-privacy {
  margin: 0;
  font-size: 0.75rem;
  opacity: 0.75;
  line-height: 1.35;
}
`;
  document.head.appendChild(style);
}

export default { mountTargetSpeakerUI };
