/**
 * vip-boot.js — VoiceIsolate Pro v22.1 bootstrap shim
 * Startup diagnostics (server check + model probe) + VoiceIsolatePro alias.
 */
(function () {
  'use strict';

  // ── Startup banner helper ───────────────────────────────────────────────
  function showBanner(html) {
    var el = document.getElementById('vip-startup-banner');
    var msg = document.getElementById('vip-startup-msg');
    if (!el || !msg) return;
    msg.innerHTML = html;
    el.style.display = 'flex';
    console.warn('[VIP] startup:', msg.textContent);
  }

  // ── Model probe (HEAD request, fails silently on network errors) ────────
  async function probeModel(name) {
    try {
      var r = await fetch('./models/' + name, { method: 'HEAD', cache: 'no-store' });
      return r.ok || r.status === 304;
    } catch (_) { return false; }
  }

  // ── Master diagnostics ──────────────────────────────────────────────────
  async function runDiagnostics() {
    // A. file:// protocol — no server running
    if (location.protocol === 'file:') {
      showBanner(
        '🖥️ <b>No local server detected.</b> ' +
        'Run <code style="background:#111;padding:1px 4px;border-radius:3px">python -m http.server 8080</code> ' +
        'inside <code style="background:#111;padding:1px 4px;border-radius:3px">public/app/</code>, ' +
        'then open <a href="http://localhost:8080" style="color:#ef4444">http://localhost:8080</a>. ' +
        'SharedArrayBuffer + ONNX models require an HTTP server.'
      );
      window.VIP_ML_AVAILABLE = false;
      return;
    }

    // B. Server reachability check
    var serverOk = false;
    try {
      var ping = await fetch('./', { method: 'HEAD', cache: 'no-store' });
      serverOk = ping.ok || ping.status === 304 || ping.status === 403;
    } catch (_) { serverOk = false; }

    if (!serverOk) {
      showBanner(
        '🔌 <b>Network error — is the server running?</b> ' +
        'Start your dev server, then reload. ' +
        '<em style="color:#888">(' + location.origin + ' unreachable)</em>'
      );
      window.VIP_ML_AVAILABLE = false;
      return;
    }

    // C. ONNX model file probe
    var required = ["demucs_v4.onnx", "bsrnn.onnx", "silero_vad.onnx", "ecapa_tdnn.onnx"];
    var missing = [];
    for (var i = 0; i < required.length; i++) {
      var found = await probeModel(required[i]);
      if (!found) missing.push(required[i]);
    }

    if (missing.length > 0) {
      showBanner(
        '📦 <b>Missing model file' + (missing.length > 1 ? 's' : '') + ':</b> ' +
        missing.map(function(m){ return '<code style="background:#111;padding:1px 4px;border-radius:3px">' + m + '</code>'; }).join(', ') +
        ' — place in <code style="background:#111;padding:1px 4px;border-radius:3px">public/app/models/</code> and reload. ' +
        '<a href="https://github.com/Joker5514/VoiceIsolate-Pro#models" target="_blank" ' +
        'rel="noopener" style="color:#ef4444">Download guide ↗</a>'
      );
      window.VIP_ML_AVAILABLE = false;
      console.info('[VIP] ML stages disabled — running classical DSP fallback.');
    } else {
      window.VIP_ML_AVAILABLE = true;
      console.info('[VIP] All models found ✓ ML pipeline enabled.');
    }
  }

  // ── VoiceIsolatePro alias (original boot logic) ─────────────────────────
  function aliasOrCreate() {
    if (typeof VoiceIsolatePro === 'undefined') {
      console.error('[vip-boot] VoiceIsolatePro class not found — is app.js loaded?');
      return;
    }
    // If already instantiated, just ensure aliases are set
    if (window._vipApp) {
      if (!window.vip) window.vip = window._vipApp;
      _callAuthInit();
      return;
    }
    if (window.vip instanceof VoiceIsolatePro) {
      window._vipApp = window.vip;
      if (typeof window._vipApp.init === 'function' && !window._vipApp._initCalled) {
        window._vipApp._initCalled = true;
        try { window._vipApp.init(); } catch(e){ console.warn('[vip-boot] app.init() error:', e); }
      }
      console.info('[vip-boot] Aliased window.vip → window._vipApp ✓');
      _callAuthInit();
      return;
    }
    try {
      var app = new VoiceIsolatePro();
      // Call app.init() — wires up sliders, DOM cache, canvases, and 3D
      app._initCalled = true;
      if (typeof app.init === 'function') {
        try { app.init(); } catch(e){ console.warn('[vip-boot] app.init() error:', e); }
      }
      window.vip     = app;
      window._vipApp = app;  // pipeline-orchestrator.js polls this
      console.info('[vip-boot] VoiceIsolatePro instantiated + init() called ✓');
    } catch (err) {
      console.error('[vip-boot] Failed to instantiate VoiceIsolatePro:', err);
    }
    _callAuthInit();
  }

  // Auth.init() shows the login modal and restores the session.
  // Must be called after app is ready so the DOM is fully available.
  function _callAuthInit() {
    if (typeof Auth !== 'undefined' && typeof Auth.init === 'function' && !Auth.isLoggedIn && Auth.currentUser === null) {
      Auth.init().catch(function(e){ console.warn('[vip-boot] Auth.init error:', e); });
    } else {
      console.warn('[vip-boot] Auth module not loaded — login modal skipped');
    }
  }

  // ── Boot sequence ───────────────────────────────────────────────────────
  function boot() {
    runDiagnostics();   // async, non-blocking — banner shows if something's wrong
    aliasOrCreate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
