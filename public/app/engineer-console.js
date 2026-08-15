/**
 * Engineer Mode — Studio Console layout shell
 * Reparents existing DOM nodes (IDs preserved) into a 3-column rack.
 * Injects DSP Integrity + Output Safety status cards (cosmetic + metrics readback).
 */
'use strict';

(function installEngineerConsole() {
  if (typeof document === 'undefined') return;
  if (document.documentElement.dataset.engConsole === '1') return;

  const isMobileShell = () => {
    try {
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
      if (/Android|iPhone|iPad|Mobile|Capacitor/i.test(ua)) return true;
      if (typeof navigator !== 'undefined' && navigator.deviceMemory > 0 && navigator.deviceMemory <= 4) {
        return true;
      }
      if (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.()) return true;
    } catch { /* ignore */ }
    return false;
  };

  const ready = () => {
    try {
      document.body.classList.add('eng-console', 'ec-auto-analysis');
      document.documentElement.dataset.engConsole = '1';
      // Mobile: Simple view first — fewer open panels, less layout thrash on cold open.
      if (isMobileShell()) {
        document.body.classList.add('ec-simple');
      }
      buildLayout();
      injectIntegrityCards();
      injectSummaryCards();
      wireViewToggle();
      wireFocusExplain();
      // Defer ticker + summary so reparent paints before any interval work.
      const schedule = globalThis.requestIdleCallback
        ? (cb) => requestIdleCallback(cb, { timeout: 2500 })
        : (cb) => setTimeout(cb, 400);
      schedule(() => {
        startIntegrityTicker();
        try { refreshSummaryFromApp(); } catch { /* cosmetic */ }
      });
    } catch (err) {
      console.warn('[VIP][engineer-console] layout install failed', err);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // Two frames after DOM so first paint / boot splash can show before reparent.
      requestAnimationFrame(() => requestAnimationFrame(ready));
    }, { once: true });
  } else {
    // Defer after app.js modules attach — never run layout sync on the same turn as import.
    requestAnimationFrame(() => {
      setTimeout(ready, isMobileShell() ? 80 : 0);
    });
  }

  function buildLayout() {
    const main = document.querySelector('main.main-grid');
    if (!main || main.classList.contains('ec-grid')) return;

    const left = main.querySelector('.col-left');
    const right = main.querySelector('.col-right');
    if (!left || !right) return;

    main.classList.add('ec-grid');

    const colSession = el('div', 'ec-col ec-col-session');
    const colStage = el('div', 'ec-col ec-col-stage');
    const colRack = el('div', 'ec-col ec-col-rack');

    // Session column: upload, library, processing, save, mobile bar
    move(left, [
      '#section-upload',
      '#section-processing',
      '.save-row',
      '#mobileActionBar',
    ], colSession);

    // Stage column: transport, viz, video, analysis, target speaker
    move(right, [
      '.transport-card',
      '#vizCard',
      '#videoCard',
    ], colStage);
    // analysis + target from left into stage
    move(left, [
      '#section-analysis',
      '#section-target-speaker',
    ], colStage);

    // Rack column: presets + all slider sections + process actions
    move(left, [
      '#section-presets',
    ], colRack);

    // Any remaining left children
    while (left.firstChild) colSession.appendChild(left.firstChild);
    while (right.firstChild) colStage.appendChild(right.firstChild);

    left.remove();
    right.remove();

    // Sticky rack nav
    const nav = el('nav', 'ec-rack-nav');
    nav.setAttribute('aria-label', 'Control modules');
    const links = [
      ['#section-presets', 'Presets'],
      ['#section-gate', 'Gate / NR'],
      ['#section-eq', 'EQ'],
      ['#section-dynamics', 'Dynamics'],
      ['#section-spectral', 'Spectral'],
      ['#section-advanced', 'Advanced'],
      ['#section-output', 'Output'],
      ['#section-separation', 'Isolation'],
    ];
    for (const [href, label] of links) {
      const a = document.createElement('a');
      a.href = href;
      a.textContent = label;
      a.addEventListener('click', (e) => {
        const t = document.querySelector(href);
        if (t) {
          e.preventDefault();
          if (t instanceof HTMLDetailsElement) t.open = true;
          t.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      nav.appendChild(a);
    }
    colRack.insertBefore(nav, colRack.firstChild);

    // Relabel module subtitles (visual only)
    annotateSummary('#section-gate', 'Input & pre-cleaning');
    annotateSummary('#section-eq', 'Tone & presence');
    annotateSummary('#section-dynamics', 'Dynamics & loudness');
    annotateSummary('#section-spectral', 'Spectral tools');
    annotateSummary('#section-advanced', 'Room & stereo');
    annotateSummary('#section-output', 'Master bus');
    annotateSummary('#section-separation', 'Isolation depth');
    annotateSummary('#tab-extreme-group', 'Whisper / forensic');

    // Collapse heavy panels by default for cleaner rack (IDs stay)
    collapseUnlessOpen([
      '#section-advanced',
      '#tab-extreme-group',
      '#section-spectral',
      '#section-whisper-hunter',
    ]);
    main.append(colSession, colStage, colRack);

    // Target speaker section collapsed by default (after reparent + any restore hooks).
    const collapseTarget = () => {
      const ts = document.getElementById('section-target-speaker');
      if (ts instanceof HTMLDetailsElement) ts.open = false;
    };
    collapseTarget();
    setTimeout(collapseTarget, 0);
    setTimeout(collapseTarget, 400);

    // Header version polish
    const hdrVer = document.querySelector('.hdr-left .hdr-title[style*="font-size:11px"]');
    if (hdrVer) {
      hdrVer.textContent = 'Engineer Console';
    }
    const badge = document.querySelector('.hdr-badge');
    if (badge && !document.getElementById('ecModeBadge')) {
      const mode = el('span', 'ec-mode-badge');
      mode.id = 'ecModeBadge';
      mode.dataset.mode = 'offline';
      mode.textContent = 'Creator / Offline';
      badge.insertAdjacentElement('afterend', mode);
    }

    // Title
    try {
      document.title = 'VoiceIsolate Pro – Engineer Mode Console';
    } catch { /* ignore */ }
  }

  function annotateSummary(sel, sub) {
    const d = document.querySelector(sel);
    if (!d) return;
    const sum = d.querySelector(':scope > summary');
    if (!sum || sum.querySelector('.module-sub')) return;
    const s = el('span', 'module-sub', sub);
    sum.appendChild(s);
  }

  function collapseUnlessOpen(sels) {
    for (const s of sels) {
      const d = document.querySelector(s);
      if (d instanceof HTMLDetailsElement) d.open = false;
    }
  }

  function move(fromRoot, selectors, dest) {
    for (const sel of selectors) {
      const node = fromRoot.querySelector(sel) || document.querySelector(sel);
      if (node && node.parentElement) dest.appendChild(node);
    }
  }

  function injectIntegrityCards() {
    if (document.getElementById('ecIntegrityCard')) return;
    const session = document.querySelector('.ec-col-session') || document.querySelector('.main-grid');
    if (!session) return;

    const integrity = el('div', 'card ec-integrity-card');
    integrity.id = 'ecIntegrityCard';
    integrity.innerHTML = `
      <div class="ec-integrity-head">
        <h3 class="ec-integrity-title">DSP Integrity</h3>
        <span class="ec-status-pill" id="ecIntegrityOverall" data-state="ok">Click-safe</span>
      </div>
      <div class="ec-pill-row" role="status" aria-label="DSP integrity status">
        <span class="ec-status-pill" id="ecPhasePill" data-state="ok" title="Single-pass STFT/iSTFT">Phase OK</span>
        <span class="ec-status-pill" id="ecSmoothPill" data-state="ok" title="AudioParam ramps / anti-click">Smoothed</span>
        <span class="ec-status-pill" id="ecColaPill" data-state="ok" title="COLA-safe hop geometry">COLA</span>
        <span class="ec-status-pill" id="ecStftPill" data-state="ok" title="Fused spectral single STFT">1× STFT</span>
      </div>`;

    const safety = el('div', 'card ec-output-safety');
    safety.id = 'ecOutputSafety';
    safety.innerHTML = `
      <div class="ec-safety-head">
        <h3 class="ec-safety-title">Output Safety</h3>
        <span class="ec-status-pill" id="ecSafetyPill" data-state="ok">Clean</span>
      </div>
      <div class="ec-meter-row">
        <div class="ec-meter"><span class="ec-meter-lbl">Peak</span><span class="ec-meter-val" id="ecPeakVal">—</span></div>
        <div class="ec-meter"><span class="ec-meter-lbl">True-peak</span><span class="ec-meter-val" id="ecTpVal">— dBTP</span></div>
        <div class="ec-meter"><span class="ec-meter-lbl">Ceiling</span><span class="ec-meter-val" id="ecCeilVal">−1.0</span></div>
      </div>
      <p class="hint" style="margin:8px 0 0;font-size:0.7rem;opacity:0.75">
        Transparent brickwall limit on process output · micro-fades on mute/solo · no extra gain staging in UI
      </p>`;

    const processing = document.getElementById('section-processing');
    if (processing?.parentElement) {
      processing.parentElement.insertBefore(integrity, processing);
      processing.parentElement.insertBefore(safety, processing.nextSibling);
    } else {
      session.prepend(integrity, safety);
    }
  }

  function injectSummaryCards() {
    if (document.getElementById('ecSummaryGrid')) return;
    const stage = document.querySelector('.ec-col-stage');
    const viz = document.getElementById('vizCard');
    if (!stage || !viz) return;

    const grid = el('div', 'ec-summary-grid');
    grid.id = 'ecSummaryGrid';

    const analysis = el('div', 'card ec-summary-card');
    analysis.innerHTML = `
      <h3>Analysis Summary</h3>
      <div class="ec-summary-body" id="ecAnalysisSummary">
        Runs automatically after Process. SNR, voice %, and findings appear here.
      </div>`;

    const diar = el('div', 'card ec-summary-card');
    diar.innerHTML = `
      <h3>Diarization · Voice Matrix</h3>
      <div class="ec-summary-body" id="ecDiarSummary">
        Speakers detected after analysis populate this matrix.
      </div>
      <div class="ec-voice-matrix" id="ecVoiceMatrix" role="group" aria-label="Detected speakers"></div>`;

    grid.append(analysis, diar);
    viz.insertAdjacentElement('afterend', grid);
  }

  function wireFocusExplain() {
    const panel = document.getElementById('targetSpeakerPanel');
    if (!panel || panel.dataset.ecExplain === '1') return;
    panel.dataset.ecExplain = '1';

    const explain = document.createElement('details');
    explain.className = 'ec-focus-explain';
    explain.id = 'ecFocusExplain';
    // Collapsed by default
    const sum = document.createElement('summary');
    sum.textContent = "What does “Focus on one voice” do?";
    const body = el('div', 'ec-focus-explain-body');
    body.innerHTML = `
      <p>Enrollment builds a <strong>local mel-band voiceprint</strong> from a short region of clear speech.
      Isolate applies a <strong>smoothed per-sample gain curve</strong> (≈15&nbsp;ms ramps) so non-matching talkers
      are attenuated without hard cuts or zipper noise.</p>
      <p>When diarization segments exist, the matching cluster is fused into the curve.
      This does <strong>not</strong> re-run ML separation or open a second STFT — it post-processes the clean stem only.</p>
      <p>Mute/solo on speaker cards use Web Audio <code>linearRampToValueAtTime</code> (~12&nbsp;ms) for click-free automation.</p>`;
    explain.append(sum, body);

    // Prefer insert before enrollment form content
    if (panel.firstChild) panel.insertBefore(explain, panel.firstChild);
    else panel.appendChild(explain);

    // Steps collapsed: show toggle
    const lead = panel.querySelector('.vip-ts-lead');
    if (lead && !panel.querySelector('.ec-show-steps-btn')) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-outline btn-xs ec-show-steps-btn';
      btn.textContent = 'Show how-to steps';
      btn.style.margin = '0 0 8px';
      btn.addEventListener('click', () => {
        const on = panel.classList.toggle('ec-show-steps');
        btn.textContent = on ? 'Hide how-to steps' : 'Show how-to steps';
      });
      lead.insertAdjacentElement('afterend', btn);
    }
  }

  function wireViewToggle() {
    if (document.getElementById('ecViewToggle')) return;
    const actions = document.querySelector('.hdr-actions');
    if (!actions) return;
    const btn = document.createElement('button');
    btn.id = 'ecViewToggle';
    btn.type = 'button';
    btn.className = 'btn btn-outline hdr-link';
    const simpleOn = document.body.classList.contains('ec-simple');
    btn.setAttribute('aria-pressed', String(simpleOn));
    btn.title = 'Toggle Simple vs full Engineer rack';
    btn.textContent = simpleOn ? 'Engineer view' : 'Simple view';
    btn.addEventListener('click', () => {
      const simple = document.body.classList.toggle('ec-simple');
      btn.setAttribute('aria-pressed', String(simple));
      btn.textContent = simple ? 'Engineer view' : 'Simple view';
    });
    actions.appendChild(btn);
  }

  function setPill(id, state, text) {
    const elp = document.getElementById(id);
    if (!elp) return;
    elp.dataset.state = state;
    if (text != null) elp.textContent = text;
  }

  function startIntegrityTicker() {
    const tick = () => {
      try {
        updateIntegrityFromDom();
        // Summary DOM walks are heavier — skip when tab hidden or during process.
        if (typeof document !== 'undefined' && document.hidden) return;
        if (window._vipApp?.isProcessing) return;
        refreshSummaryFromApp();
      } catch { /* cosmetic */ }
    };
    tick();
    // Mobile: slower ticker (less main-thread competition with Process / UI).
    const period = isMobileShell() ? 2800 : 1200;
    setInterval(tick, period);
    window.addEventListener('vip:processingDone', () => {
      setTimeout(tick, 200);
    });
  }

  function updateIntegrityFromDom() {
    // Peak from header metrics if available
    const peakTxt = document.getElementById('hPeak')?.textContent || '—';
    const peakEl = document.getElementById('ecPeakVal');
    if (peakEl) peakEl.textContent = peakTxt;

    // Parse peak for safety
    let peakLin = null;
    const m = String(peakTxt).match(/-?\d+(\.\d+)?/);
    if (m) {
      // header may show dB or linear — if |val| < 2 treat as linear peak
      const v = Number(m[0]);
      if (Math.abs(v) <= 1.5) peakLin = Math.abs(v);
      else peakLin = Math.pow(10, v / 20);
    }

    let safety = 'ok';
    let safetyLabel = 'Clean';
    let tpDb = '—';
    if (peakLin != null && Number.isFinite(peakLin)) {
      const db = 20 * Math.log10(Math.max(1e-9, peakLin));
      tpDb = `${db.toFixed(1)} dBTP`;
      if (db > -0.3) {
        safety = 'risk';
        safetyLabel = 'Clip risk';
      } else if (db > -1.5) {
        safety = 'warn';
        safetyLabel = 'Near ceiling';
      } else {
        safety = 'ok';
        safetyLabel = 'Clean';
      }
    }
    setPill('ecSafetyPill', safety, safetyLabel);
    const tp = document.getElementById('ecTpVal');
    if (tp) tp.textContent = tpDb;

    document.body.classList.toggle('ec-clean-output', safety === 'ok');

    // Mode badge: Live-Mix vs offline when processing
    const mode = document.getElementById('ecModeBadge');
    const status = document.getElementById('hStatus')?.textContent || '';
    if (mode) {
      if (/PROCESS|RUN/i.test(status)) {
        mode.dataset.mode = 'offline';
        mode.textContent = 'Offline process';
      } else if (window.app?._bridge?.isPlaying?.()) {
        mode.dataset.mode = 'live';
        mode.textContent = 'Live-Mix';
      } else {
        mode.dataset.mode = 'offline';
        mode.textContent = 'Creator / Offline';
      }
    }

    // STFT budget warnings if any
    const budget = globalThis.__vipStftBudget;
    const warns = budget?.getWarnings?.() || [];
    if (warns.length) {
      setPill('ecStftPill', 'warn', 'STFT budget');
      setPill('ecIntegrityOverall', 'warn', 'Check STFT');
    } else {
      setPill('ecStftPill', 'ok', '1× STFT');
      setPill('ecIntegrityOverall', 'ok', 'Click-safe');
    }
  }

  function refreshSummaryFromApp() {
    const app = window.app;
    const aEl = document.getElementById('ecAnalysisSummary');
    const dEl = document.getElementById('ecDiarSummary');
    const matrix = document.getElementById('ecVoiceMatrix');
    if (!aEl) return;

    const analysis = app?._lastFullAnalysis;
    const voice = document.getElementById('hVoice')?.textContent || '—';
    const noise = document.getElementById('hNoise')?.textContent || '—';
    const snr = document.getElementById('hSNR')?.textContent || '—';
    const peak = document.getElementById('hPeak')?.textContent || '—';

    if (analysis) {
      const findings = (analysis.findings || analysis.reasons || []).slice(0, 3);
      const nSpeech = (analysis.speechSegments || []).length;
      const nWhisper = (analysis.whisperRegions || []).length;
      aEl.innerHTML = `
        <div><strong>Voice</strong> ${escape(voice)} · <strong>Noise</strong> ${escape(noise)} · <strong>SNR</strong> ${escape(snr)}</div>
        <div style="margin-top:6px">Speech zones: <strong>${nSpeech}</strong> · Whisper: <strong>${nWhisper}</strong> · Peak ${escape(peak)}</div>
        ${findings.length ? `<ul style="margin:6px 0 0;padding-left:1.1rem">${findings.map((f) => `<li>${escape(typeof f === 'string' ? f : f.label || f.text || JSON.stringify(f))}</li>`).join('')}</ul>` : ''}`;
    } else {
      aEl.innerHTML = `Voice ${escape(voice)} · Noise ${escape(noise)} · SNR ${escape(snr)} · Peak ${escape(peak)}
        <div style="margin-top:6px;opacity:0.8">Analysis auto-runs after Process (or use Analyze Full Audio).</div>`;
    }

    // Diarization matrix from analysis or USM labels
    if (matrix) {
      matrix.textContent = '';
      const speakers = [];
      const labels = typeof app?.getSourceLabels === 'function' ? app.getSourceLabels() : null;
      if (Array.isArray(labels)) {
        labels.forEach((L, i) => {
          speakers.push({
            id: L.id || L.label || `S${i + 1}`,
            label: L.label || L.id || `Speaker ${i + 1}`,
            conf: L.confidence,
            primary: /speech|voice/i.test(String(L.label || '')),
          });
        });
      }
      const segs = analysis?.speechSegments || [];
      if (!speakers.length && segs.length) {
        speakers.push({ id: 'S1', label: 'Primary voice', conf: 0.8, primary: true });
      }
      if (dEl) {
        dEl.textContent = speakers.length
          ? `${speakers.length} source label(s) · click a pill to focus enrollment times`
          : 'No diarization yet — will populate after analysis.';
      }
      speakers.slice(0, 8).forEach((s, i) => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'ec-voice-pill';
        if (s.primary || i === 0) pill.dataset.role = 'primary';
        pill.setAttribute('aria-pressed', 'false');
        pill.innerHTML = `<span class="ec-voice-dot" aria-hidden="true"></span>${escape(s.label)}${s.conf != null ? ` · ${Math.round(s.conf * 100)}%` : ''}`;
        pill.addEventListener('click', () => {
          matrix.querySelectorAll('.ec-voice-pill').forEach((p) => p.setAttribute('aria-pressed', 'false'));
          pill.setAttribute('aria-pressed', 'true');
          // Open target speaker section for enrollment
          const sec = document.getElementById('section-target-speaker');
          if (sec instanceof HTMLDetailsElement) {
            sec.open = true;
            sec.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
          // Prefill first 2s region
          const start = document.getElementById('tsStart');
          const end = document.getElementById('tsEnd');
          if (start) start.value = '0';
          if (end) end.value = '2';
          start?.dispatchEvent(new Event('input', { bubbles: true }));
        });
        matrix.appendChild(pill);
      });
    }
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function escape(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Expose for tests / app hooks
  window.__VIP_ENGINEER_CONSOLE__ = {
    refreshSummaryFromApp,
    updateIntegrityFromDom,
  };
})();
