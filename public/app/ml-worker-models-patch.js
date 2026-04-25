/* =============================================================================
   VoiceIsolate Pro — ML Worker: Model Absence Graceful Degradation Patch
   File: public/app/ml-worker-models-patch.js
   Threads from Space v11 | Patch v2.1
   ─────────────────────────────────────────────────────────────────────────────
   PURPOSE
   -------
   Non-destructive monkey-patch applied to the ML Worker AFTER construction,
   BEFORE the 'init' postMessage is sent.

   When .onnx model files are absent from public/app/models/:
     • Intercepts ml-worker.js 'modelMissing' messages
     • Stamps ⚠ DSP badges on affected pipeline stage UI elements
     • Shows a dismissible banner listing absent files + source links
     • DSP passthrough continues — pipeline produces output on all 35 stages

   INTEGRATION (handled by pipeline-orchestrator.js since v2.0)
   ─────────────────────────────────────────────────────────────
   window._mlWorkerPatch(worker, { logToConsole, onWarning, onManifest });

   CONSTRAINTS
   ──────────────────
   ✅ 100% local — no fetch to external URLs
   ✅ Non-destructive — does NOT modify ml-worker.js prototype
   ✅ Works with or without model files present
   ============================================================================= */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  MODEL MANIFEST
//  Single source of truth for stage↔model mapping.
//  Keys MUST match MODEL_REGISTRY keys in ml-worker-fetch-cache.js.
// ─────────────────────────────────────────────────────────────────────────────
const MODEL_MANIFEST = {
  noise_classifier:    { stageId: 'S04', stageName: 'S04 Noise Classification',     filename: 'noise_classifier.onnx',    sizeLabel: '~2.5 MB', sourceUrl: 'https://github.com/karolpiczak/ESC-50' },
  silero_vad:          { stageId: 'S05', stageName: 'S05 Voice Activity Detection',  filename: 'silero_vad.onnx',          sizeLabel: '~1.7 MB', sourceUrl: 'https://github.com/snakers4/silero-vad/tree/master/files' },
  deepfilter:          { stageId: 'S08', stageName: 'S08 Deep Spectral Filter',      filename: 'deepfilter-int8.onnx',     sizeLabel: '~9 MB',   sourceUrl: 'https://github.com/Rikorose/DeepFilterNet/releases' },
  dns2_conformer_small:{ stageId: 'S10', stageName: 'S10 DNS2 Noise Suppression',   filename: 'dns2_conformer_small.onnx',sizeLabel: '~14 MB',  sourceUrl: 'https://github.com/microsoft/DNS-Challenge' },
  bsrnn:               { stageId: 'S11', stageName: 'S11 BSRNN Source Separation',  filename: 'bsrnn-int8.onnx',          sizeLabel: '~37 MB',  sourceUrl: 'https://github.com/bytedance/music_source_separation' },
  demucs:              { stageId: 'S13', stageName: 'S13 Demucs v4 Voice Isolation', filename: 'demucs-v4-int8.onnx',      sizeLabel: '~82 MB',  sourceUrl: 'https://github.com/facebookresearch/demucs' },
  ecapa_tdnn:          { stageId: 'S17', stageName: 'S17 ECAPA-TDNN Speaker ID',     filename: 'ecapa-tdnn-int8.onnx',    sizeLabel: '~20 MB',  sourceUrl: 'https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb' },
  convtasnet:          { stageId: 'S22', stageName: 'S22 ConvTasNet Speaker Sep.',   filename: 'convtasnet-int8.onnx',    sizeLabel: '~18 MB',  sourceUrl: 'https://github.com/asteroid-team/asteroid' }
};

// Normalise worker model keys → manifest keys (worker may use shorter aliases)
function _normalizeKey(key) {
  const map = {
    vad:       'silero_vad',
    silero:    'silero_vad',
    df:        'deepfilter',
    dns:       'dns2_conformer_small',
    dns2:      'dns2_conformer_small',
    ecapa:     'ecapa_tdnn',
    noise:     'noise_classifier',
    classifier:'noise_classifier'
  };
  return map[key] || key;
}

// ─────────────────────────────────────────────────────────────────────────────
//  BANNER UI
// ─────────────────────────────────────────────────────────────────────────────
function _ensureBanner(absentModels) {
  const BANNER_ID = 'vip-missing-models-banner';
  let banner = document.getElementById(BANNER_ID);
  if (banner) banner.remove();
  if (absentModels.length === 0) return;

  banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'alert');
  banner.setAttribute('aria-live', 'polite');
  banner.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:99999',
    'background:#1c1a14', 'border-bottom:1px solid #f59e0b',
    'color:#fde68a', 'font:500 12px/1.4 "Courier New",monospace',
    'padding:8px 12px', 'display:flex', 'align-items:flex-start',
    'gap:12px', 'max-height:160px', 'overflow-y:auto'
  ].join(';');

  const icon = document.createElement('span');
  icon.textContent = '⚠';
  icon.style.cssText = 'color:#f59e0b;font-size:16px;flex-shrink:0;margin-top:1px;';

  const body = document.createElement('div');
  body.style.cssText = 'flex:1;min-width:0;';

  const title = document.createElement('strong');
  title.textContent = `VoiceIsolate Pro — ${absentModels.length} ML model(s) absent. Running DSP passthrough on affected stages.`;
  title.style.display = 'block';
  title.style.marginBottom = '4px';

  const list = document.createElement('ul');
  list.style.cssText = 'margin:0;padding-left:16px;list-style:disc;';
  absentModels.forEach(key => {
    const meta = MODEL_MANIFEST[key];
    if (!meta) return;
    const li   = document.createElement('li');
    li.style.marginBottom = '2px';
    li.innerHTML =
      `<b>${meta.stageId}</b> — <code>${meta.filename}</code> (${meta.sizeLabel}) ` +
      `<a href="${meta.sourceUrl}" target="_blank" rel="noopener noreferrer" ` +
      `style="color:#7dd3fc;text-decoration:underline;">source ↗</a>`;
    list.appendChild(li);
  });

  const hint = document.createElement('p');
  hint.style.cssText = 'margin:4px 0 0;color:#a3a19a;font-size:11px;';
  hint.textContent = 'Place .onnx files in public/app/models/ — see models/README.md for conversion scripts.';

  body.appendChild(title);
  body.appendChild(list);
  body.appendChild(hint);

  const close = document.createElement('button');
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss model warning');
  close.style.cssText = [
    'background:none', 'border:none', 'color:#a3a19a', 'cursor:pointer',
    'font-size:14px', 'padding:0', 'flex-shrink:0', 'align-self:flex-start',
    'line-height:1'
  ].join(';');
  close.onclick = () => banner.remove();

  banner.appendChild(icon);
  banner.appendChild(body);
  banner.appendChild(close);
  document.body.appendChild(banner);
}

// ─────────────────────────────────────────────────────────────────────────────
//  STAGE BADGE STAMPING
//  Stamps ⚠ DSP or ● ML badges on pipeline stage UI elements.
//  Called by pipeline-orchestrator.js onManifest callback + exposed globally.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stamp all stage badges based on manifest status.
 * @param {Record<string, 'present'|'absent'>} manifest  key → status
 */
window._stampPipelineStages = function stampPipelineStages(manifest) {
  // Validate: warn on unmapped manifest keys
  const unmapped = Object.keys(MODEL_MANIFEST).filter(k => {
    const normK = _normalizeKey(k);
    return !(normK in manifest) && !(k in manifest);
  });
  if (unmapped.length) {
    console.warn('[VIP patch] Manifest keys not returned by worker:', unmapped);
  }

  Object.entries(MODEL_MANIFEST).forEach(([modelKey, meta]) => {
    const status   = manifest[modelKey] || manifest[_normalizeKey(modelKey)] || 'absent';
    const isAbsent = status === 'absent';

    // Try multiple selector strategies
    const selectors = [
      `[data-stage-id="${meta.stageId}"]`,
      `[data-stage="${meta.stageId}"]`,
      `[data-stage-id="${meta.stageId.toLowerCase()}"]`
    ];
    let el = null;
    for (const sel of selectors) {
      el = document.querySelector(sel);
      if (el) break;
    }
    if (!el) return;

    const existing = el.querySelector('.vip-stage-ml-status');
    if (existing) existing.remove();

    const badge = document.createElement('span');
    badge.className    = 'vip-stage-ml-status';
    badge.style.cssText =
      `color:${isAbsent ? '#f59e0b' : '#34d399'};` +
      'font-size:10px;font-weight:700;margin-left:4px;' +
      'cursor:help;vertical-align:middle;';
    badge.textContent  = isAbsent ? '⚠ DSP' : '● ML';
    badge.title = isAbsent
      ? `${meta.stageName}: model absent (${meta.filename})\nDSP passthrough active.`
      : `${meta.stageName}: ML inference active (${meta.filename})`;

    const label =
      el.querySelector('.stage-name,.stage-label,.stage-title,h4,h3,span') || el;
    label.appendChild(badge);
  });
};

// ─────────────────────────────────────────────────────────────────────────────
//  MODEL FILE PRESENCE CHECK  (HEAD requests — fast, no download)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HEAD-check all model files. Returns map of key → 'present'|'absent'.
 * @returns {Promise<Record<string, 'present'|'absent'>>}
 */
window._checkModelFiles = async function checkModelFiles() {
  const results = {};
  await Promise.allSettled(
    Object.entries(MODEL_MANIFEST).map(async ([key, meta]) => {
      try {
        const r = await fetch(`models/${meta.filename}`, { method: 'HEAD' });
        results[key] = r.ok ? 'present' : 'absent';
      } catch {
        results[key] = 'absent';
      }
    })
  );
  return results;
};

// ─────────────────────────────────────────────────────────────────────────────
//  CORE PATCH FUNCTION
//  Intercepts worker messages and wires onWarning / onManifest callbacks.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply graceful-degradation patch to an ML Worker instance.
 *
 * @param {Worker} worker          The ml-worker.js Worker instance
 * @param {object} [opts]
 * @param {boolean} [opts.logToConsole=true]
 * @param {function} [opts.onWarning]   (stageId, modelKey, meta) => void
 * @param {function} [opts.onManifest]  (manifest) => void
 */
window._mlWorkerPatch = function mlWorkerPatch(worker, opts = {}) {
  const { logToConsole = true, onWarning, onManifest } = opts;

  const absentKeys   = new Set();
  const manifestSeen = {};

  // Wrap the existing onmessage handler (if any) — non-destructive
  const _prevOnMessage = worker.onmessage;

  worker.onmessage = function patchedOnMessage(e) {
    const { type } = e.data || {};

    // ── Handle 'modelMissing' notifications from ml-worker.js ─────────────
    if (type === 'modelMissing') {
      const rawKey  = e.data.model || e.data.key || '';
      const normKey = _normalizeKey(rawKey);
      const meta    = MODEL_MANIFEST[normKey] || MODEL_MANIFEST[rawKey] || {};

      absentKeys.add(normKey);
      manifestSeen[normKey] = 'absent';

      if (logToConsole) {
        console.warn(
          `[VIP patch] ML stage missing model: "${rawKey}" (stage ${meta.stageId || '?'}) — DSP passthrough active`
        );
      }
      if (typeof onWarning === 'function') {
        onWarning(meta.stageId || rawKey, normKey, meta);
      }
    }

    // ── Handle 'modelLoaded' confirmations ────────────────────────────────
    if (type === 'modelLoaded') {
      const rawKey  = e.data.model || e.data.key || '';
      const normKey = _normalizeKey(rawKey);
      manifestSeen[normKey] = 'present';
      if (logToConsole) {
        const meta = MODEL_MANIFEST[normKey] || {};
        console.info(`[VIP patch] ML model loaded: "${rawKey}" (${meta.stageName || normKey})`);
      }
    }

    // ── Handle 'ready' — fire manifest callback + show banner ─────────────
    if (type === 'ready') {
      // Merge any model status the worker reported in ready payload
      if (e.data.models && Array.isArray(e.data.models)) {
        e.data.models.forEach(k => {
          const normK = _normalizeKey(k);
          if (!(normK in manifestSeen)) manifestSeen[normK] = 'present';
        });
      }
      // Fill in absent status for any manifest keys not yet seen
      Object.keys(MODEL_MANIFEST).forEach(k => {
        if (!(k in manifestSeen)) manifestSeen[k] = 'absent';
      });

      if (typeof onManifest === 'function') {
        onManifest({ ...manifestSeen });
      }
      // Stamp all stage badges
      if (typeof window._stampPipelineStages === 'function') {
        window._stampPipelineStages({ ...manifestSeen });
      }
      // Show missing-model banner
      const absent = Object.entries(manifestSeen)
        .filter(([, v]) => v === 'absent')
        .map(([k]) => k);
      _ensureBanner(absent);
    }

    // ── Pass through to original handler ──────────────────────────────────
    if (typeof _prevOnMessage === 'function') {
      _prevOnMessage.call(worker, e);
    }
  };

  // ── Run immediate file-presence check (HEAD-only, fast) ─────────────────
  // This gives us early badge/banner state before the worker fires 'ready'.
  window._checkModelFiles().then((presence) => {
    Object.assign(manifestSeen, presence);

    const earlyAbsent = Object.entries(presence)
      .filter(([, v]) => v === 'absent')
      .map(([k]) => k);

    if (earlyAbsent.length > 0) {
      _ensureBanner(earlyAbsent);
      if (typeof window._stampPipelineStages === 'function') {
        window._stampPipelineStages(presence);
      }
      if (logToConsole) {
        console.warn(
          '[VIP patch] Absent model files detected:',
          earlyAbsent.map(k => MODEL_MANIFEST[k]?.filename || k)
        );
      }
    }
  });
};

console.debug('[VIP] ml-worker-models-patch.js loaded — graceful ML degradation ready (v2.1).');
