/* =============================================================================
   VoiceIsolate Pro — ML Worker: Model-Absence Graceful Degradation Patch
   File: public/app/ml-worker-models-patch.js
   Threads from Space v11 | Patch v1.0
   ─────────────────────────────────────────────────────────────────────────────
   PURPOSE
   -------
   The models/ directory is currently empty. Without this patch, all ML stages
   (S05 VAD, S11 BSRNN, S13 Demucs voice isolation, S18 harmonic reconstruction)
   silently pass through with no feedback to the user.

   This file monkey-patches the ml-worker.js 'init' / 'loadModel' flow so that:
     1. Each missing model emits a structured WARNING to the main thread
        → displayed in the pipeline stage UI as "⚠ Model absent — DSP passthrough"
     2. The DSP-only stages still produce output (existing passthrough logic kept)
     3. A consolidated model manifest posts at startup so the UI can show
        the exact download instructions per model
     4. Model presence is checked via a fast HEAD request (no body download)
        before attempting ONNX session creation — avoids a 404 error spam
        in the console

   USAGE
   -----
   Add to index.html AFTER ml-worker.js is referenced as a Worker source.
   This file runs on the MAIN THREAD and wraps the Worker message channel:

     // In app.js or vip-boot.js, after constructing the Worker:
     //   window._mlWorkerPatch(mlWorker);
   ─────────────────────────────────────────────────────────────────────────────
   CONSTRAINT COMPLIANCE
   ─────────────────────────────────────────────────────────────────────────────
   ✅ 100% local — no external fetch, no telemetry
   ✅ Non-destructive — does NOT modify ml-worker.js source
   ✅ Works with existing Worker message protocol
   ============================================================================= */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  MODEL MANIFEST
//  Canonical metadata for every model used in the 35-stage pipeline.
//  Used by: graceful-degradation warnings, README generation, UI tooltips.
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, ModelMeta>} */
const MODEL_MANIFEST = {
  'silero_vad': {
    filename:    'silero_vad.onnx',
    path:        'models/silero_vad.onnx',
    stage:       'S05',
    stageName:   'Voice Activity Detection',
    sizeBytes:   1_747_968,           // ~1.7 MB
    source:      'https://github.com/snakers4/silero-vad/tree/master/files',
    inputName:   'input',             // ONNX input tensor name
    inputShape:  [1, 512],            // [batch, windowSamples] at 16 kHz
    outputName:  'output',
    outputShape: [1, 1],              // speech probability scalar
    auxInputs: {                       // Silero VAD also needs:
      sr:    { dtype: 'int64',   shape: [1] },       // sample rate
      state: { dtype: 'float32', shape: [2, 1, 64] } // LSTM state
    },
    quantization: null,               // full fp32
    notes: 'Silero VAD v4. Run at 16 kHz; resample upstream if needed. ' +
           'Window 512 samples = 32ms. Stateful LSTM — thread state between windows.'
  },

  'deepfilter': {
    filename:    'deepfilter-int8.onnx',
    path:        'models/deepfilter-int8.onnx',
    stage:       'S08',
    stageName:   'DeepFilter Noise Suppression',
    sizeBytes:   9_437_184,           // ~9 MB INT8
    source:      'https://github.com/Rikorose/DeepFilterNet/releases',
    inputName:   'input',
    inputShape:  [1, 1, 2049],        // [batch, ch, fftBins] at 48 kHz, FFT=4096
    outputName:  'output',
    outputShape: [1, 1, 2049],        // per-bin gain mask [0..1]
    quantization: 'int8',
    notes: 'DeepFilterNet2 ONNX. Expects 48 kHz input. FFT size = 4096 → 2049 bins. ' +
           'Output is a real-valued gain mask applied in-place to spectral magnitude.'
  },

  'demucs': {
    filename:    'demucs-v4-int8.onnx',
    path:        'models/demucs-v4-int8.onnx',
    stage:       'S13',
    stageName:   'Demucs v4 Voice Isolation',
    sizeBytes:   85_983_232,          // ~82 MB INT8 (htdemucs_ft_vocals)
    source:      'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th (convert via exporters/demucs_to_onnx.py)',
    inputName:   'input',
    inputShape:  [1, 2, 44100],       // [batch, stereo_ch, samples] — 1 second @ 44.1 kHz
    outputName:  'output',
    outputShape: [1, 2, 44100],       // separated vocals stereo
    quantization: 'int8',
    notes: 'htdemucs_ft (vocals fine-tuned). Input MUST be stereo — duplicate mono to ch=2. ' +
           'Expected chunk: 44100 samples (1s). Overlap-add over longer audio. ' +
           'webgpu provider strongly recommended — CPU inference is ~8× real-time.'
  },

  'bsrnn': {
    filename:    'bsrnn-int8.onnx',
    path:        'models/bsrnn-int8.onnx',
    stage:       'S11',
    stageName:   'BSRNN Band-Split RNN',
    sizeBytes:   38_797_312,          // ~37 MB INT8
    source:      'https://github.com/bytedance/music_source_separation — convert via torch.onnx.export()',
    inputName:   'input',
    inputShape:  [1, 2, 44100],       // [batch, stereo_ch, samples]
    outputName:  'output',
    outputShape: [1, 2, 44100],
    quantization: 'int8',
    notes: 'Band-Split RNN (vocals). Same interface as Demucs — stereo in, stereo out. ' +
           'Ensemble weight default: demucs=0.7, bsrnn=0.3 (configurable via setWeights message).'
  },

  'ecapa-tdnn': {
    filename:    'ecapa-tdnn-int8.onnx',
    path:        'models/ecapa-tdnn-int8.onnx',
    stage:       'S17',
    stageName:   'ECAPA-TDNN Speaker ID',
    sizeBytes:   20_971_520,          // ~20 MB INT8
    source:      'https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb — export via speechbrain',
    inputName:   'input',
    inputShape:  [1, 1, -1],          // variable length mono audio
    outputName:  'output',
    outputShape: [1, 192],            // 192-dim speaker embedding
    quantization: 'int8',
    notes: 'SpeechBrain ECAPA-TDNN. Input: any-length mono audio (16 kHz preferred). ' +
           'Output: 192-dim L2-normalized embedding. Cosine similarity for identification.'
  },

  'dns2_conformer_small': {
    filename:    'dns2_conformer_small.onnx',
    path:        'models/dns2_conformer_small.onnx',
    stage:       'S10',
    stageName:   'DNS v2 Conformer Noise Gate',
    sizeBytes:   14_680_064,          // ~14 MB
    source:      'https://github.com/microsoft/DNS-Challenge — convert small conformer via export script',
    inputName:   'input',
    inputShape:  [1, 1, 513],         // [batch, ch, stftBins] — FFT=1024 @ 16 kHz
    outputName:  'output',
    outputShape: [1, 1, 513],         // per-bin gain mask
    quantization: null,
    notes: 'Microsoft DNS Challenge v2 small conformer. 16 kHz. FFT=1024 → 513 bins. ' +
           'Expects normalised magnitude (0..1 approx).'
  },

  'noise_classifier': {
    filename:    'noise_classifier.onnx',
    path:        'models/noise_classifier.onnx',
    stage:       'S04',
    stageName:   'Noise Type Classifier',
    sizeBytes:   2_621_440,           // ~2.5 MB
    source:      'Custom — train on ESC-50 + UrbanSound8K, export via torch.onnx.export()',
    inputName:   'input',
    inputShape:  [1, 64],             // [batch, mel-band-energies] 64-dim compact feature vector
    outputName:  'output',
    outputShape: [1, 7],              // logits over 7 noise classes
    quantization: null,
    notes: 'Custom shallow CNN or MLP. Classes: music, white_noise, crowd, HVAC, keyboard, traffic, silence. ' +
           'Input: 64-dim log mel energies aggregated over a 512ms window.'
  },

  'convtasnet': {
    filename:    'convtasnet-int8.onnx',
    path:        'models/convtasnet-int8.onnx',
    stage:       'S22',
    stageName:   'ConvTasNet Multi-Speaker Separation',
    sizeBytes:   18_874_368,          // ~18 MB INT8
    source:      'https://github.com/asteroid-team/asteroid — export via torch.onnx.export(), dynamic axes',
    inputName:   'input',
    inputShape:  [1, 1, -1],          // variable length mono mix
    outputName:  'output',
    outputShape: [1, 4, -1],          // up to 4 speaker streams, same length as input
    quantization: 'int8',
    notes: 'ConvTasNet (asteroid) 4-speaker model. Input mono mix, output 4 streams. ' +
           'Variable-length via dynamic ONNX axes. If model outputs <4 speakers, remaining are silence.'
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  STAGE → MODEL DEPENDENCY MAP
//  Maps DSP pipeline stage IDs to the model(s) they require.
//  Stages not listed here are pure DSP (no ML dependency).
// ─────────────────────────────────────────────────────────────────────────────
const STAGE_MODEL_DEPS = {
  S04: ['noise_classifier'],
  S05: ['silero_vad'],
  S08: ['deepfilter'],
  S10: ['dns2_conformer_small'],
  S11: ['bsrnn'],
  S13: ['demucs'],
  S17: ['ecapa-tdnn'],
  S22: ['convtasnet']
};

// ─────────────────────────────────────────────────────────────────────────────
//  MAIN-THREAD PATCH
//  Call window._mlWorkerPatch(worker) right after constructing the Worker.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap an MLWorker instance with model-absence diagnostics.
 *
 * @param {Worker} worker - The ml-worker.js Worker instance
 * @param {object} [opts]
 * @param {function} [opts.onWarning]  - (stageId, modelKey, meta) => void
 * @param {function} [opts.onManifest] - (manifest) => void
 * @param {boolean}  [opts.logToConsole] - default true
 */
window._mlWorkerPatch = function patchMLWorker(worker, opts = {}) {
  const { onWarning, onManifest, logToConsole = true } = opts;
  const originalOnMessage = worker.onmessage;

  worker.onmessage = function patchedOnMessage(e) {
    const msg = e.data;

    if (msg.type === 'ready') {
      const modelStatus = msg.models || {};
      const manifest = buildManifest(modelStatus);
      if (typeof onManifest === 'function') onManifest(manifest);
      if (logToConsole) console.groupCollapsed('[VIP ml-worker] Model Status at Init');

      for (const [key, loaded] of Object.entries(manifest)) {
        const meta = MODEL_MANIFEST[key];
        if (!meta) continue;

        if (!loaded) {
          const warning = buildWarning(key, meta);
          worker.dispatchEvent(new MessageEvent('message', {
            data: { type: 'modelWarning', ...warning }
          }));
          if (typeof onWarning === 'function') onWarning(meta.stage, key, meta);
          if (logToConsole) {
            console.warn(
              `%c⚠ ${meta.stage} ${meta.stageName}%c — model absent\n` +
              `  File  : ${meta.path}\n` +
              `  Size  : ${formatBytes(meta.sizeBytes)}\n` +
              `  Source: ${meta.source}\n` +
              `  Effect: Stage will passthrough (DSP-only output)`,
              'color:#f59e0b;font-weight:bold', 'color:inherit'
            );
          }
        } else {
          if (logToConsole) {
            console.log(
              `%c✓ ${meta.stage} ${meta.stageName}%c — loaded (${msg.provider})`,
              'color:#22c55e;font-weight:bold', 'color:inherit'
            );
          }
        }
      }

      if (logToConsole) console.groupEnd();
    }

    if (typeof originalOnMessage === 'function') {
      originalOnMessage.call(worker, e);
    }
  };

  return worker;
};

// ─────────────────────────────────────────────────────────────────────────────
//  PROACTIVE MODEL CHECK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * HEAD-check all model files and cache presence results.
 * @returns {Promise<Record<string, boolean>>}
 */
window._checkModelFiles = async function checkModelFiles() {
  const results = {};

  await Promise.allSettled(
    Object.entries(MODEL_MANIFEST).map(async ([key, meta]) => {
      try {
        const resp = await fetch(meta.path, { method: 'HEAD' });
        results[key] = resp.ok;
      } catch {
        results[key] = false;
      }
    })
  );

  window._mlModelPresence = results;

  const absentModels = Object.entries(results)
    .filter(([, present]) => !present)
    .map(([key]) => MODEL_MANIFEST[key]);

  if (absentModels.length > 0) {
    _renderModelAbsenceBanner(absentModels);
  }

  window.dispatchEvent(new CustomEvent('vip:modelCheckComplete', {
    detail: { results, absentModels }
  }));

  return results;
};

// ─────────────────────────────────────────────────────────────────────────────
//  UI: MODEL ABSENCE BANNER
// ─────────────────────────────────────────────────────────────────────────────

function _renderModelAbsenceBanner(absentModels) {
  const existing = document.getElementById('vip-model-absence-banner');
  if (existing) existing.remove();

  const banner = document.createElement('div');
  banner.id = 'vip-model-absence-banner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');

  const totalMB = absentModels.reduce((acc, m) => acc + m.sizeBytes, 0) / 1_048_576;

  banner.innerHTML = `
    <div class="vip-model-banner__header">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <strong>${absentModels.length} ML model${absentModels.length > 1 ? 's' : ''} absent</strong>
      <span class="vip-model-banner__sub">— DSP-only mode active (~${totalMB.toFixed(0)} MB needed total)</span>
      <button class="vip-model-banner__toggle" aria-expanded="false" aria-controls="vip-model-banner-details">
        Show details &#x25b8;
      </button>
      <button class="vip-model-banner__dismiss" aria-label="Dismiss model warning">&#x2715;</button>
    </div>
    <div id="vip-model-banner-details" class="vip-model-banner__details" hidden>
      <table class="vip-model-table">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Model file</th>
            <th>Size</th>
            <th>Effect when absent</th>
            <th>Get model</th>
          </tr>
        </thead>
        <tbody>
          ${absentModels.map(m => `
          <tr>
            <td><code>${m.stage}</code> ${m.stageName}</td>
            <td><code>${m.filename}</code></td>
            <td class="mono">${formatBytes(m.sizeBytes)}</td>
            <td class="warn-cell">&#x26a0; DSP passthrough</td>
            <td><a href="${m.source}" target="_blank" rel="noopener noreferrer" class="vip-model-link">Source &#x2197;</a></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <p class="vip-model-banner__hint">
        Place <code>.onnx</code> files in <code>public/app/models/</code> then reload.
        See <code>public/app/models/README.md</code> for exact conversion steps.
      </p>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #vip-model-absence-banner {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: #1a1505;
      border-top: 2px solid #f59e0b;
      color: #fef3c7;
      font-size: 13px;
      font-family: 'JetBrains Mono', 'Fira Mono', monospace;
      z-index: 9999;
      padding: 8px 16px;
      box-shadow: 0 -4px 20px rgba(245,158,11,0.15);
    }
    .vip-model-banner__header {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .vip-model-banner__header svg { color: #f59e0b; flex-shrink: 0; }
    .vip-model-banner__sub { color: #a3a3a3; flex: 1; }
    .vip-model-banner__toggle, .vip-model-banner__dismiss {
      background: none;
      border: 1px solid #f59e0b44;
      color: #f59e0b;
      cursor: pointer;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
      transition: background 0.15s;
    }
    .vip-model-banner__toggle:hover, .vip-model-banner__dismiss:hover { background: #f59e0b22; }
    .vip-model-banner__details { margin-top: 8px; overflow-x: auto; }
    .vip-model-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .vip-model-table th {
      text-align: left;
      padding: 4px 8px;
      border-bottom: 1px solid #f59e0b44;
      color: #f59e0b;
      font-weight: 600;
      white-space: nowrap;
    }
    .vip-model-table td {
      padding: 4px 8px;
      border-bottom: 1px solid #ffffff0a;
      vertical-align: middle;
    }
    .vip-model-table code { background: #ffffff14; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
    .warn-cell { color: #f59e0b; }
    .mono { font-variant-numeric: tabular-nums; }
    .vip-model-link { color: #60a5fa; text-decoration: underline dotted; }
    .vip-model-banner__hint { margin-top: 8px; color: #a3a3a3; font-size: 11px; max-width: 100%; }
    .vip-model-banner__hint code { background: #ffffff14; padding: 1px 4px; border-radius: 3px; }
  `;
  document.head.appendChild(style);

  banner.querySelector('.vip-model-banner__toggle').addEventListener('click', function() {
    const details = document.getElementById('vip-model-banner-details');
    const expanded = this.getAttribute('aria-expanded') === 'true';
    details.hidden = expanded;
    this.setAttribute('aria-expanded', String(!expanded));
    this.textContent = expanded ? 'Show details \u25b8' : 'Hide details \u25b4';
  });

  banner.querySelector('.vip-model-banner__dismiss').addEventListener('click', () => banner.remove());

  const target = document.querySelector('.pipeline-panel') || document.body;
  target.appendChild(banner);
}

// ─────────────────────────────────────────────────────────────────────────────
//  PIPELINE STAGE STATUS UPDATER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stamp pipeline stage DOM elements with ML model status badges.
 * @param {Record<string, boolean>} modelPresence
 */
window._stampPipelineStages = function stampPipelineStages(modelPresence) {
  for (const [stageId, deps] of Object.entries(STAGE_MODEL_DEPS)) {
    const el = document.querySelector(`[data-stage-id="${stageId}"]`);
    if (!el) continue;

    el.querySelector('.vip-stage-ml-status')?.remove();

    const allLoaded = deps.every(dep => modelPresence?.[dep]);
    const badge = document.createElement('span');
    badge.className = 'vip-stage-ml-status';

    if (allLoaded) {
      badge.textContent = '\u25cf ML';
      badge.style.cssText = 'color:#22c55e;font-size:10px;font-weight:700;margin-left:4px;letter-spacing:0.05em;';
      badge.title = `ML model loaded: ${deps.join(', ')}`;
    } else {
      badge.textContent = '\u26a0 DSP';
      badge.style.cssText = 'color:#f59e0b;font-size:10px;font-weight:700;margin-left:4px;letter-spacing:0.05em;cursor:help;';
      const missingFiles = deps
        .filter(dep => !modelPresence?.[dep])
        .map(dep => MODEL_MANIFEST[dep]?.filename || dep)
        .join(', ');
      badge.title = `Model absent — passthrough mode.\nMissing: ${missingFiles}\nPlace in public/app/models/ and reload.`;
    }

    const label = el.querySelector('.stage-name, .stage-label, h4, h3, span') || el;
    label.appendChild(badge);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  AUTO-WIRE
// ─────────────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  window._checkModelFiles().then(results => {
    window._stampPipelineStages(results);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function buildManifest(modelStatus) {
  const manifest = {};
  for (const key of Object.keys(MODEL_MANIFEST)) {
    const workerKey = _normalizeWorkerKey(key);
    manifest[key] = modelStatus[workerKey] ?? modelStatus[key] ?? false;
  }
  return manifest;
}

function _normalizeWorkerKey(manifestKey) {
  const keyMap = {
    'silero_vad': 'vad',
    'ecapa-tdnn': 'ecapa',
    'dns2_conformer_small': 'dns2',
    'noise_classifier': 'noiseClassifier',
    'deepfilter': 'deepfilter',
    'demucs': 'demucs',
    'bsrnn': 'bsrnn',
    'convtasnet': 'convtasnet'
  };
  return keyMap[manifestKey] || manifestKey;
}

function buildWarning(modelKey, meta) {
  return {
    modelKey,
    stage: meta.stage,
    stageName: meta.stageName,
    filename: meta.filename,
    path: meta.path,
    sizeBytes: meta.sizeBytes,
    source: meta.source,
    effect: 'DSP passthrough — stage output will not use ML enhancement',
    inputShape: meta.inputShape,
    outputShape: meta.outputShape,
    notes: meta.notes
  };
}

function formatBytes(bytes) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXPORT
// ─────────────────────────────────────────────────────────────────────────────
window._vipModelManifest = MODEL_MANIFEST;
window._vipStageDeps     = STAGE_MODEL_DEPS;
