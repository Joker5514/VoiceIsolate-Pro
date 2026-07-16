/**
 * research-mode.js — Engineer Mode research / academic export panel
 *
 * Loads as a classic deferred script after app.js. Hooks pipeline events
 * and exposes config + benchmark export (100% local JSON download).
 */
(function () {
  'use strict';

  const PANEL_ID = 'vipResearchPanel';
  const METRICS_ID = 'vipBenchMetrics';

  function $(id) {
    return document.getElementById(id);
  }

  async function loadModules() {
    const [
      research,
      bench,
      ort,
      schema,
    ] = await Promise.all([
      import('/src/core/ResearchSession.js'),
      import('/src/pipeline/BenchmarkHarness.js'),
      import('/src/core/OrtStatus.js'),
      import('/src/core/ParameterSchema.js'),
    ]);
    return { research, bench, ort, schema };
  }

  function ensurePanel() {
    if ($(PANEL_ID)) return $(PANEL_ID);
    const host = document.querySelector('.presets-wrap')
      || document.querySelector('.main-grid')
      || document.body;
    const wrap = document.createElement('div');
    wrap.id = PANEL_ID;
    wrap.className = 'vip-research-panel';
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'Research mode');
    wrap.innerHTML = [
      '<div class="vip-research-head">',
      '  <strong>Research Mode</strong>',
      '  <span id="vipOrtPill" class="vip-ort-pill" data-state="unknown">ORT idle</span>',
      '</div>',
      '<p class="vip-research-hint">Logs models, FFT/hop, slider snapshot, stage timings. Local JSON only — no network.</p>',
      '<label class="vip-research-check"><input type="checkbox" id="vipResearchEnable" /> Enable research logging</label>',
      '<label class="vip-research-check"><input type="checkbox" id="vipResearchDeterministic" /> Deterministic flags</label>',
      '<div class="vip-research-actions">',
      '  <button type="button" class="btn btn-outline" id="vipResearchExport">Export Session JSON</button>',
      '  <button type="button" class="btn btn-outline" id="vipSchemaExport">Export Parameter Schema</button>',
      '</div>',
      '<div id="' + METRICS_ID + '" class="vip-bench-metrics" aria-live="polite">Bench idle</div>',
    ].join('');
    host.appendChild(wrap);
    return wrap;
  }

  function injectStyles() {
    if (document.getElementById('vip-research-css')) return;
    const s = document.createElement('style');
    s.id = 'vip-research-css';
    s.textContent = [
      '.vip-research-panel{margin:12px 0;padding:12px 14px;border:1px solid rgba(220,38,38,.22);border-radius:10px;',
      'background:linear-gradient(165deg,rgba(220,38,38,.06),rgba(0,0,0,.25));}',
      '.vip-research-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;}',
      '.vip-research-head strong{font:600 11px/1 "JetBrains Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:#fca5a5;}',
      '.vip-ort-pill{font:500 10px/1 "JetBrains Mono",monospace;padding:4px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.12);}',
      '.vip-ort-pill[data-state="webgpu"]{color:#86efac;border-color:rgba(34,197,94,.4);}',
      '.vip-ort-pill[data-state="wasm"]{color:#fcd34d;border-color:rgba(234,179,8,.4);}',
      '.vip-ort-pill[data-state="error"]{color:#fca5a5;border-color:rgba(239,68,68,.5);}',
      '.vip-research-hint{margin:0 0 8px;font-size:12px;color:#9090a4;line-height:1.4;}',
      '.vip-research-check{display:flex;align-items:center;gap:8px;font-size:12px;color:#c4c4d0;margin:4px 0;}',
      '.vip-research-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;}',
      '.vip-bench-metrics{margin-top:10px;font:500 11px/1.4 "JetBrains Mono",monospace;color:#a3a3b8;}',
    ].join('');
    document.head.appendChild(s);
  }

  function downloadJson(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function collectVipParams() {
    const p = (typeof window !== 'undefined' && window.VIP_PARAMS) ? window.VIP_PARAMS : {};
    return { ...p };
  }

  async function boot() {
    injectStyles();
    ensurePanel();
    const mods = await loadModules();
    const { beginResearchSession, getActiveResearchSession, endResearchSession } = mods.research;
    const { globalBenchmark } = mods.bench;
    const { subscribeOrtStatus, formatOrtProviderLabel, probeWebGpuAvailable, getOrtStatus } = mods.ort;
    const { PARAMETER_SCHEMA, snapshotParams } = mods.schema;

    void probeWebGpuAvailable();

    const pill = $('vipOrtPill');
    const metrics = $(METRICS_ID);
    const paintOrt = (s) => {
      if (!pill) return;
      pill.textContent = formatOrtProviderLabel(s);
      pill.dataset.state = s.provider || 'unknown';
    };
    paintOrt(getOrtStatus());
    subscribeOrtStatus((s) => {
      paintOrt(s);
      // Cockpit ORT + ML pills
      const setPill = window._setVipEnginePill;
      if (typeof setPill === 'function') {
        if (s.provider === 'webgpu') {
          setPill('engOrtPill', 'ready');
          setPill('engMlPill', 'ready');
        } else if (s.provider === 'wasm') {
          setPill('engOrtPill', 'ready');
          setPill('engMlPill', 'ready');
        } else if (s.provider === 'probing') {
          setPill('engOrtPill', 'loading');
          setPill('engMlPill', 'loading');
        } else if (s.provider === 'error') {
          setPill('engOrtPill', 'error');
          setPill('engMlPill', 'error');
        }
      }
    });

    const paintBench = () => {
      if (metrics) metrics.textContent = globalBenchmark.formatStatusLine();
    };
    setInterval(paintBench, 1500);

    window.addEventListener('vip:fileLoaded', (ev) => {
      const enabled = $('vipResearchEnable')?.checked;
      if (!enabled) return;
      const name = ev.detail?.name || '';
      beginResearchSession({
        sourceName: name,
        mode: 'creator',
        params: collectVipParams(),
        deterministic: Boolean($('vipResearchDeterministic')?.checked),
        modelIds: ['bsrnn_vocals'],
      }).mark('file_loaded', { name });
      globalBenchmark.start('pipeline');
    });

    window.addEventListener('vip:processingDone', () => {
      globalBenchmark.end('pipeline');
      paintBench();
      const sess = getActiveResearchSession();
      if (sess) {
        sess.setMetrics({
          totalMs: globalBenchmark.summary().lastMs,
        });
        sess.updateParams(collectVipParams());
        sess.mark('processing_done');
        endResearchSession();
      }
    });

    $('vipResearchExport')?.addEventListener('click', () => {
      let sess = getActiveResearchSession();
      if (!sess) {
        sess = beginResearchSession({
          sourceName: window._vipApp?._sourceName || '',
          params: collectVipParams(),
          deterministic: Boolean($('vipResearchDeterministic')?.checked),
        });
        sess.mark('manual_export');
        endResearchSession();
      }
      sess.updateParams(collectVipParams());
      sess.setMetrics({
        totalMs: globalBenchmark.summary().lastMs,
      });
      sess.download();
    });

    $('vipSchemaExport')?.addEventListener('click', () => {
      downloadJson({
        schemaVersion: 1,
        count: PARAMETER_SCHEMA.length,
        parameters: PARAMETER_SCHEMA,
        defaults: snapshotParams({}),
      }, 'vip-parameter-schema.json');
    });

    console.info('[VIP] research-mode.js ready');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { boot().catch(console.warn); });
  } else {
    boot().catch(console.warn);
  }
})();
