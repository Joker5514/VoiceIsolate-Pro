/**
 * VoiceIsolate Pro — debug-menu.js
 * Live system debug panel. Toggle with the DBG button in header or press ` (backtick).
 * Auto-refreshes every 500 ms. Intercepts console for live event log.
 * Never imported in the normal boot path — loaded on-demand after app init.
 */

const DBG_VERSION = '1.0.0';
const REFRESH_MS  = 500;
const LOG_MAX     = 200;

/* ── Internal log buffer ─────────────────────────────────────────────── */
const _log = [];
let   _logSeq = 0;

function pushLog(level, args) {
  const ts = new Date().toISOString().slice(11, 19);
  const msg = args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ').slice(0, 200);
  _log.push({ ts, level, msg, id: ++_logSeq });
  if (_log.length > LOG_MAX) _log.shift();
}

/* Intercept console once */
(function installConsoleHook() {
  if (window._vipDbgHooked) return;
  window._vipDbgHooked = true;
  const orig = {};
  for (const lvl of ['log', 'info', 'warn', 'error']) {
    orig[lvl] = console[lvl].bind(console);
    console[lvl] = function(...args) {
      orig[lvl](...args);
      pushLog(lvl === 'error' ? 'err' : lvl === 'warn' ? 'warn' : lvl === 'info' ? 'info' : 'log', args);
    };
  }
  window.addEventListener('error', e => pushLog('err', [e.message || String(e)]));
  window.addEventListener('unhandledrejection', e => pushLog('err', ['Unhandled:', String(e.reason)]));
})();

/* ── HTML template ─────────────────────────────────────────────────────── */
function buildHTML() {
  return `
<div class="dbg-header" id="vip-dbg-drag">
  <span class="dbg-header-title">◉ VIP Debug Menu <span class="dbg-refresh-dot" id="dbgRefDot"></span></span>
  <span class="dbg-header-hint">v${DBG_VERSION} · \` to toggle</span>
  <button class="dbg-close" id="dbgClose" title="Close" aria-label="Close debug panel">✕</button>
</div>

<div class="dbg-body">

  <!-- SYSTEM -->
  <div class="dbg-section" id="dbg-sec-system">
    <div class="dbg-section-title" data-sec="system">
      SYSTEM <span class="dbg-section-chevron">▾</span>
    </div>
    <div class="dbg-section-body">
      <div class="dbg-row"><span class="dbg-label">AudioContext</span><span class="dbg-value" id="dbgACtx">—</span></div>
      <div class="dbg-row"><span class="dbg-label">crossOriginIsolated</span><span class="dbg-value" id="dbgCOI">—</span></div>
      <div class="dbg-row"><span class="dbg-label">SharedArrayBuffer</span><span class="dbg-value" id="dbgSAB">—</span></div>
      <div class="dbg-row"><span class="dbg-label">WebGPU</span><span class="dbg-value" id="dbgGPU">—</span></div>
      <div class="dbg-row"><span class="dbg-label">AudioWorklet API</span><span class="dbg-value" id="dbgWorklet">—</span></div>
      <div class="dbg-row"><span class="dbg-label">ONNX Runtime</span><span class="dbg-value" id="dbgORT">—</span></div>
      <div class="dbg-row"><span class="dbg-label">Three.js</span><span class="dbg-value" id="dbgThree">—</span></div>
      <div class="dbg-row"><span class="dbg-label">Memory (JS heap)</span><span class="dbg-value" id="dbgMem">—</span></div>
    </div>
  </div>

  <!-- APP -->
  <div class="dbg-section" id="dbg-sec-app">
    <div class="dbg-section-title" data-sec="app">
      APP INSTANCE <span class="dbg-section-chevron">▾</span>
    </div>
    <div class="dbg-section-body">
      <div class="dbg-row"><span class="dbg-label">VoiceIsolatePro</span><span class="dbg-value" id="dbgApp">—</span></div>
      <div class="dbg-row"><span class="dbg-label">runPipeline</span><span class="dbg-value" id="dbgRunPipe">—</span></div>
      <div class="dbg-row"><span class="dbg-label">Sliders in DOM</span><span class="dbg-value" id="dbgSliders">—</span></div>
      <div class="dbg-row"><span class="dbg-label">VIP_PARAMS keys</span><span class="dbg-value" id="dbgParams">—</span></div>
      <div class="dbg-row"><span class="dbg-label">Forensic log</span><span class="dbg-value" id="dbgForensic">—</span></div>
      <div class="dbg-row"><span class="dbg-label">Module errors</span><span class="dbg-value" id="dbgModErr">—</span></div>
    </div>
  </div>

  <!-- PIPELINE -->
  <div class="dbg-section" id="dbg-sec-pipe">
    <div class="dbg-section-title" data-sec="pipe">
      PIPELINE <span class="dbg-section-chevron">▾</span>
    </div>
    <div class="dbg-section-body">
      <div class="dbg-row"><span class="dbg-label">Status</span><span class="dbg-value" id="dbgPipeStatus">—</span></div>
      <div class="dbg-row"><span class="dbg-label">Stage</span><span class="dbg-value" id="dbgPipeStage">—</span></div>
      <div class="dbg-row"><span class="dbg-label">Progress</span><span class="dbg-value" id="dbgPipePct">—</span></div>
      <div class="dbg-stage-bar"><div class="dbg-stage-fill" id="dbgStageFill" style="width:0%"></div></div>
      <div class="dbg-row" style="margin-top:4px"><span class="dbg-label">PipelineState</span><span class="dbg-value" id="dbgPipeState">—</span></div>
      <div class="dbg-row"><span class="dbg-label">Orchestrator</span><span class="dbg-value" id="dbgOrch">—</span></div>
    </div>
  </div>

  <!-- MODELS -->
  <div class="dbg-section" id="dbg-sec-models">
    <div class="dbg-section-title" data-sec="models">
      MODELS <span class="dbg-section-chevron">▾</span>
    </div>
    <div class="dbg-section-body">
      <div class="dbg-model-grid" id="dbgModelGrid">
        <div class="dbg-model-item"><div class="dbg-model-dot dim"></div><span class="dbg-model-name">Loading…</span></div>
      </div>
    </div>
  </div>

  <!-- WORKERS -->
  <div class="dbg-section" id="dbg-sec-workers">
    <div class="dbg-section-title" data-sec="workers">
      WORKERS <span class="dbg-section-chevron">▾</span>
    </div>
    <div class="dbg-section-body">
      <div class="dbg-row"><span class="dbg-label">ml-worker.js</span><span class="dbg-value" id="dbgWkML">—</span></div>
      <div class="dbg-row"><span class="dbg-label">dsp-processor.js</span><span class="dbg-value" id="dbgWkDSP">—</span></div>
      <div class="dbg-row"><span class="dbg-label">dsp-worker.js</span><span class="dbg-value" id="dbgWkDSPW">—</span></div>
    </div>
  </div>

  <!-- PERFORMANCE -->
  <div class="dbg-section" id="dbg-sec-perf">
    <div class="dbg-section-title" data-sec="perf">
      PERFORMANCE <span class="dbg-section-chevron">▾</span>
    </div>
    <div class="dbg-section-body">
      <div class="dbg-row"><span class="dbg-label">Refresh interval</span><span class="dbg-value" id="dbgInterval">${REFRESH_MS}ms</span></div>
      <div class="dbg-row"><span class="dbg-label">Uptime</span><span class="dbg-value" id="dbgUptime">—</span></div>
      <div class="dbg-row"><span class="dbg-label">DOM nodes</span><span class="dbg-value" id="dbgDomNodes">—</span></div>
      <div class="dbg-row"><span class="dbg-label">StyleSheets</span><span class="dbg-value" id="dbgSheets">—</span></div>
      <div class="dbg-sparkline" id="dbgSparkline">
        ${Array.from({length: 20}, () => '<div class="dbg-spark-bar" style="height:4px"></div>').join('')}
      </div>
    </div>
  </div>

  <!-- EVENT LOG -->
  <div class="dbg-section" id="dbg-sec-log">
    <div class="dbg-section-title" data-sec="log">
      LIVE EVENT LOG <span class="dbg-section-chevron">▾</span>
    </div>
    <div class="dbg-section-body" style="padding:6px">
      <div class="dbg-log" id="dbgLog"></div>
    </div>
  </div>

</div>

<div class="dbg-footer">
  <button class="dbg-btn dbg-btn-green" id="dbgRunAudit">▶ Run Audit</button>
  <button class="dbg-btn dbg-btn-blue"  id="dbgCopyLog">⎘ Copy Log</button>
  <button class="dbg-btn dbg-btn-blue"  id="dbgExport">↓ Export</button>
  <span class="dbg-spacer"></span>
  <button class="dbg-btn dbg-btn-red"   id="dbgClearLog">✕ Clear</button>
</div>

<div class="dbg-toast" id="dbgToast"></div>
<div class="dbg-resize" id="dbgResize"></div>
`;
}

/* ── DOM references (populated after injection) ──────────────────────── */
let _panel = null;
let _btn   = null;
let _raf   = null;
let _timer = null;
let _open  = false;
let _startTime = Date.now();
let _perfHistory = Array(20).fill(0);
let _lastLogId = 0;
let _workerStatus = { ml: null, dsp: null, dspw: null };

/* ── Utility helpers ──────────────────────────────────────────────────── */
function badge(state, text) {
  return `<span class="dbg-badge ${state}">${text}</span>`;
}
function cls(el, state, text) {
  if (!el) return;
  el.className = `dbg-value ${state}`;
  el.innerHTML = text;
}
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}
function showToast(msg) {
  const t = document.getElementById('dbgToast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

/* ── Worker reachability (one-shot at open) ──────────────────────────── */
function checkWorker(path, key) {
  fetch(path, { method: 'HEAD' })
    .then(r => { _workerStatus[key] = r.ok ? 'ok' : 'err'; })
    .catch(() => { _workerStatus[key] = 'err'; });
}

/* ── Refresh cycle ─────────────────────────────────────────────────────── */
function refresh() {
  if (!_open || !_panel) return;

  const dot = document.getElementById('dbgRefDot');
  if (dot) { dot.classList.add('flash'); setTimeout(() => dot.classList.remove('flash'), 100); }

  /* ── System ── */
  const app = window._vipApp || window.vip;

  // AudioContext
  const acState = app && app._audioCtx ? app._audioCtx.state
    : (window._vipAudioCtx ? window._vipAudioCtx.state : null);
  const acEl = document.getElementById('dbgACtx');
  if (acState === 'running')   cls(acEl, 'ok',  badge('ok',  'running'));
  else if (acState === 'suspended') cls(acEl, 'warn', badge('warn', 'suspended'));
  else if (acState === 'closed')    cls(acEl, 'err',  badge('err',  'closed'));
  else                              cls(acEl, 'dim',  badge('dim',  'none'));

  // crossOriginIsolated
  const coi = window.crossOriginIsolated;
  cls(document.getElementById('dbgCOI'), coi ? 'ok' : 'err', badge(coi ? 'ok' : 'err', String(coi)));

  // SharedArrayBuffer
  const sab = typeof SharedArrayBuffer !== 'undefined';
  cls(document.getElementById('dbgSAB'), sab ? 'ok' : 'err', badge(sab ? 'ok' : 'err', sab ? 'available' : 'missing'));

  // WebGPU
  const gpu = !!navigator.gpu;
  cls(document.getElementById('dbgGPU'), gpu ? 'ok' : 'warn', badge(gpu ? 'ok' : 'warn', gpu ? 'available' : 'WASM only'));

  // AudioWorklet
  const aw = typeof AudioWorkletNode !== 'undefined';
  cls(document.getElementById('dbgWorklet'), aw ? 'ok' : 'err', badge(aw ? 'ok' : 'err', aw ? 'available' : 'missing'));

  // ONNX Runtime
  const ortLoaded = typeof ort !== 'undefined' || typeof window.ort !== 'undefined';
  cls(document.getElementById('dbgORT'), ortLoaded ? 'ok' : 'warn', badge(ortLoaded ? 'ok' : 'warn', ortLoaded ? 'loaded' : 'not yet'));

  // Three.js
  const three = typeof THREE !== 'undefined' || typeof window.THREE !== 'undefined';
  cls(document.getElementById('dbgThree'), three ? 'ok' : 'warn', badge(three ? 'ok' : 'warn', three ? 'loaded' : 'not yet'));

  // Memory
  const memEl = document.getElementById('dbgMem');
  if (performance.memory) {
    const used = performance.memory.usedJSHeapSize;
    const total = performance.memory.totalJSHeapSize;
    const pct = Math.round(used / total * 100);
    cls(memEl, pct > 85 ? 'err' : pct > 65 ? 'warn' : 'ok',
      `${fmtBytes(used)} / ${fmtBytes(total)} (${pct}%)`);
    _perfHistory.push(pct);
    _perfHistory.shift();
  } else {
    cls(memEl, 'dim', 'n/a');
  }

  /* ── App ── */
  cls(document.getElementById('dbgApp'), app ? 'ok' : 'err', badge(app ? 'ok' : 'err', app ? 'live' : 'missing'));
  cls(document.getElementById('dbgRunPipe'), app && typeof app.runPipeline === 'function' ? 'ok' : 'err',
    badge(app && typeof app.runPipeline === 'function' ? 'ok' : 'err', app && typeof app.runPipeline === 'function' ? 'ok' : 'missing'));

  const sliders = document.querySelectorAll('input[type="range"].slider').length;
  cls(document.getElementById('dbgSliders'), sliders >= 52 ? 'ok' : sliders > 0 ? 'warn' : 'err',
    `${sliders} / 52`);

  const params = window.VIP_PARAMS ? Object.keys(window.VIP_PARAMS).length : 0;
  cls(document.getElementById('dbgParams'), params > 0 ? 'ok' : 'warn', String(params));

  const flog = app && Array.isArray(app.forensicLog) ? app.forensicLog.length : null;
  cls(document.getElementById('dbgForensic'), flog !== null ? 'ok' : 'dim',
    flog !== null ? `${flog} entries` : 'n/a');

  const modErr = (window._vipModuleErrors || []).length;
  cls(document.getElementById('dbgModErr'), modErr === 0 ? 'ok' : 'err',
    modErr === 0 ? 'none' : badge('err', String(modErr) + ' errors'));

  /* ── Pipeline ── */
  const stageEl  = document.getElementById('pipeStage');
  const pctEl    = document.getElementById('pipePercent');
  const detailEl = document.getElementById('pipeDetail');
  const badgeEl  = document.getElementById('vip-proc-badge');

  const stage = stageEl ? stageEl.textContent : '—';
  const pct   = pctEl   ? pctEl.textContent   : '—';
  const detail = detailEl ? detailEl.textContent : '—';
  const pipeStatus = badgeEl ? (badgeEl.dataset.state || 'idle') : 'unknown';

  cls(document.getElementById('dbgPipeStatus'), pipeStatus === 'idle' ? 'dim' : pipeStatus === 'processing' ? 'ok' : 'warn',
    badge(pipeStatus === 'idle' ? 'dim' : 'ok', pipeStatus));
  cls(document.getElementById('dbgPipeStage'), 'ok', stage + ' · ' + detail.slice(0, 30));
  cls(document.getElementById('dbgPipePct'), 'ok', pct);

  const pctNum = parseFloat(pct) || 0;
  const fill = document.getElementById('dbgStageFill');
  if (fill) fill.style.width = pctNum + '%';

  const ps = window._vipPipelineState || window.VIP_PIPELINE_STATE;
  cls(document.getElementById('dbgPipeState'), ps ? 'ok' : 'dim', badge(ps ? 'ok' : 'dim', ps ? 'live' : 'none'));

  const orch = window._vipOrchestrator || window.VIP_ORCHESTRATOR;
  cls(document.getElementById('dbgOrch'), orch ? 'ok' : 'dim', badge(orch ? 'ok' : 'dim', orch ? 'live' : 'none'));

  /* ── Models ── */
  const grid = document.getElementById('dbgModelGrid');
  if (grid) {
    const modelNames = [
      ['silero_vad', 'Silero VAD'],
      ['silero_vad_int8', 'VAD int8'],
      ['rnnoise', 'RNNoise'],
      ['bsrnn', 'BSRNN'],
      ['demucs', 'Demucs v4'],
      ['voicefixer', 'VoiceFixer'],
    ];
    const cache = window._vipModelCache || window.VIP_MODEL_STATUS || {};
    grid.innerHTML = modelNames.map(([key, label]) => {
      const status = cache[key];
      const dotCls = status === 'loaded' ? 'ok' : status === 'loading' ? 'warn' : 'dim';
      return `<div class="dbg-model-item">
        <div class="dbg-model-dot ${dotCls}"></div>
        <span class="dbg-model-name" title="${label}">${label}</span>
      </div>`;
    }).join('');
  }

  /* ── Workers ── */
  const wml  = _workerStatus.ml;
  const wdsp = _workerStatus.dsp;
  const wdspw= _workerStatus.dspw;
  cls(document.getElementById('dbgWkML'),   wml  === 'ok' ? 'ok' : wml  === null ? 'dim' : 'err', badge(wml  === 'ok' ? 'ok' : wml  === null ? 'dim' : 'err', wml  || 'checking…'));
  cls(document.getElementById('dbgWkDSP'),  wdsp === 'ok' ? 'ok' : wdsp === null ? 'dim' : 'err', badge(wdsp === 'ok' ? 'ok' : wdsp === null ? 'dim' : 'err', wdsp || 'checking…'));
  cls(document.getElementById('dbgWkDSPW'), wdspw=== 'ok' ? 'ok' : wdspw=== null ? 'dim' : 'err', badge(wdspw=== 'ok' ? 'ok' : wdspw=== null ? 'dim' : 'err', wdspw|| 'checking…'));

  /* ── Performance ── */
  const uptime = Math.floor((Date.now() - _startTime) / 1000);
  const hh = String(Math.floor(uptime / 3600)).padStart(2,'0');
  const mm = String(Math.floor((uptime % 3600) / 60)).padStart(2,'0');
  const ss = String(uptime % 60).padStart(2,'0');
  cls(document.getElementById('dbgUptime'), 'ok', `${hh}:${mm}:${ss}`);
  cls(document.getElementById('dbgDomNodes'), 'ok', String(document.querySelectorAll('*').length));
  cls(document.getElementById('dbgSheets'), 'ok', String(document.styleSheets.length));

  // Sparkline
  const sparks = document.querySelectorAll('#dbgSparkline .dbg-spark-bar');
  const maxH = 24;
  sparks.forEach((bar, i) => {
    const v = _perfHistory[i] || 0;
    bar.style.height = Math.max(2, Math.round(v / 100 * maxH)) + 'px';
    bar.style.background = v > 85 ? 'rgba(255,68,68,0.6)' : v > 65 ? 'rgba(245,158,11,0.5)' : 'rgba(0,255,180,0.25)';
  });

  /* ── Event log (incremental) ── */
  const logEl = document.getElementById('dbgLog');
  if (logEl) {
    const newEntries = _log.filter(e => e.id > _lastLogId);
    if (newEntries.length) {
      _lastLogId = newEntries[newEntries.length - 1].id;
      const frag = document.createDocumentFragment();
      for (const e of newEntries) {
        const div = document.createElement('div');
        div.className = 'dbg-log-entry';
        div.innerHTML = `<span class="dbg-log-ts">${e.ts}</span><span class="dbg-log-tag ${e.level}">${e.level.toUpperCase()}</span><span class="dbg-log-msg" title="${e.msg.replace(/"/g,'&quot;')}">${e.msg}</span>`;
        frag.appendChild(div);
      }
      logEl.appendChild(frag);
      logEl.scrollTop = logEl.scrollHeight;
    }
  }
}

/* ── Open / Close ──────────────────────────────────────────────────────── */
function openPanel() {
  if (!_panel || _open) return;
  _open = true;
  _panel.classList.remove('hidden');
  if (_btn) _btn.classList.add('active');
  _lastLogId = _log.length > 0 ? _log[_log.length - 1].id - 1 : 0;
  checkWorker('./ml-worker.js', 'ml');
  checkWorker('./dsp-processor.js', 'dsp');
  checkWorker('./dsp-worker.js', 'dspw');
  refresh();
  _timer = setInterval(refresh, REFRESH_MS);
}

function closePanel() {
  _open = false;
  if (_panel) _panel.classList.add('hidden');
  if (_btn) _btn.classList.remove('active');
  clearInterval(_timer);
}

function togglePanel() {
  if (_open) closePanel(); else openPanel();
}

/* ── Section collapse ──────────────────────────────────────────────────── */
function initCollapse() {
  document.querySelectorAll('.dbg-section-title').forEach(title => {
    title.addEventListener('click', () => {
      const sec = title.closest('.dbg-section');
      if (sec) sec.classList.toggle('collapsed');
    });
  });
}

/* ── Drag to reposition ────────────────────────────────────────────────── */
function initDrag(panel) {
  const handle = document.getElementById('vip-dbg-drag');
  if (!handle) return;
  let ox = 0, oy = 0, startX = 0, startY = 0, dragging = false;
  handle.addEventListener('mousedown', e => {
    if (e.target.id === 'dbgClose') return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    ox = rect.left; oy = rect.top;
    startX = e.clientX; startY = e.clientY;
    panel.style.transition = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    const nx = ox + dx, ny = oy + dy;
    panel.style.right  = 'auto';
    panel.style.bottom = 'auto';
    panel.style.left   = Math.max(0, Math.min(nx, window.innerWidth  - panel.offsetWidth))  + 'px';
    panel.style.top    = Math.max(0, Math.min(ny, window.innerHeight - panel.offsetHeight)) + 'px';
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    panel.style.transition = '';
  });
}

/* ── Resize handle ─────────────────────────────────────────────────────── */
function initResize(panel) {
  const handle = document.getElementById('dbgResize');
  if (!handle) return;
  let dragging = false, startY = 0, startH = 0;
  handle.addEventListener('mousedown', e => {
    dragging = true; startY = e.clientY; startH = panel.offsetHeight;
    document.body.style.cursor = 'ns-resize';
    e.preventDefault();
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const newH = Math.max(200, Math.min(startH + (e.clientY - startY), window.innerHeight - 80));
    panel.style.maxHeight = newH + 'px';
  });
  document.addEventListener('mouseup', () => {
    dragging = false;
    document.body.style.cursor = '';
  });
}

/* ── Footer buttons ──────────────────────────────────────────────────────── */
function initButtons() {
  document.getElementById('dbgClose').addEventListener('click', closePanel);

  document.getElementById('dbgRunAudit').addEventListener('click', () => {
    if (typeof window.VIP_runAudit === 'function') {
      window.VIP_runAudit();
      showToast('Audit ran — check console');
    } else {
      showToast('VIP_runAudit not available');
    }
  });

  document.getElementById('dbgCopyLog').addEventListener('click', () => {
    const text = _log.map(e => `[${e.ts}] ${e.level.toUpperCase()} ${e.msg}`).join('\n');
    navigator.clipboard.writeText(text).then(() => showToast('Log copied!')).catch(() => showToast('Copy failed'));
  });

  document.getElementById('dbgExport').addEventListener('click', () => {
    const app = window._vipApp || window.vip;
    const report = {
      timestamp:  new Date().toISOString(),
      version:    'VoiceIsolate Pro ' + DBG_VERSION,
      system: {
        crossOriginIsolated: window.crossOriginIsolated,
        sharedArrayBuffer:   typeof SharedArrayBuffer !== 'undefined',
        webGPU:              !!navigator.gpu,
        audioWorklet:        typeof AudioWorkletNode !== 'undefined',
        ort:                 typeof window.ort !== 'undefined',
        three:               typeof THREE !== 'undefined',
        memory:              performance.memory ? {
          used:  performance.memory.usedJSHeapSize,
          total: performance.memory.totalJSHeapSize,
        } : null,
      },
      app: {
        present:  !!app,
        sliders:  document.querySelectorAll('input[type="range"].slider').length,
        params:   window.VIP_PARAMS ? Object.keys(window.VIP_PARAMS).length : 0,
        forensic: app && Array.isArray(app.forensicLog) ? app.forensicLog.length : null,
      },
      moduleErrors: window._vipModuleErrors || [],
      log: _log.slice(-100),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `vip-debug-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Debug report exported');
  });

  document.getElementById('dbgClearLog').addEventListener('click', () => {
    _log.length = 0;
    _lastLogId  = 0;
    const logEl = document.getElementById('dbgLog');
    if (logEl) logEl.innerHTML = '';
    showToast('Log cleared');
  });
}

/* ── Mount into DOM ──────────────────────────────────────────────────────── */
function mount() {
  if (document.getElementById('vip-debug-panel')) return; // already mounted

  // Panel
  _panel = document.createElement('div');
  _panel.id = 'vip-debug-panel';
  _panel.setAttribute('role', 'dialog');
  _panel.setAttribute('aria-label', 'VIP Live Debug Panel');
  _panel.innerHTML = buildHTML();
  _panel.classList.add('hidden');
  document.body.appendChild(_panel);

  // Toggle button in header
  const hdrActions = document.querySelector('.hdr-actions') || document.querySelector('.hdr');
  if (hdrActions) {
    _btn = document.createElement('button');
    _btn.id = 'vip-debug-toggle';
    _btn.type = 'button';
    _btn.setAttribute('aria-label', 'Toggle live debug menu');
    _btn.setAttribute('title', 'Live Debug Menu (` key)');
    _btn.innerHTML = '<span class="dbg-dot"></span>DBG';
    _btn.addEventListener('click', togglePanel);
    hdrActions.insertBefore(_btn, hdrActions.firstChild);
  }

  // Keyboard shortcut: backtick
  document.addEventListener('keydown', e => {
    if (e.key === '`' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        togglePanel();
        e.preventDefault();
      }
    }
  });

  initCollapse();
  initDrag(_panel);
  initResize(_panel);
  initButtons();
}

/* ── Bootstrap ─────────────────────────────────────────────────────────── */
function init() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
}

init();

// Expose for DevTools
window.VIP_DEBUG_MENU = { toggle: togglePanel, open: openPanel, close: closePanel, log: _log };
