/**
 * VoiceIsolate Pro — vip-slider-patch.js
 * =====================================================
 * Loaded LAST (after app.js) in index.html.
 * Responsibilities:
 *   1. Rebuild all tab panels using the CORRECT .sr-row
 *      structure that style.css already themes.
 *   2. Apply .realtime class to RT sliders (cyan accent).
 *   3. Set --pct CSS custom property for filled track.
 *   4. Wire every slider → workletNode / mlWorker via
 *      the SLIDER_REGISTRY targets.
 *   5. Wire preset buttons.
 *   6. Tab switching.
 *   7. Run the 20-point debug audit after init.
 *   8. Resize all canvases to their container.
 *   9. Expose window.VIP_SLIDER_REGISTRY for audit.
 */

(function VIP_SLIDER_PATCH() {
  'use strict';

  // ── Wait for DOM + app bootstrap ────────────────────────────────────
  function onReady(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  onReady(() => {
    // Give app.js a tick to finish its own DOMContentLoaded handlers
    setTimeout(init, 120);
  });

  // ── Slider definitions (mirrors app.js SLIDERS) ─────────────────────
  const SLIDERS = {
    gate: [
      { id:'gateThresh',    label:'Threshold',   min:-80, max:-5,   val:-42,  step:1,   unit:' dB', rt:true,  desc:'Signal level below which audio is gated' },
      { id:'gateRange',     label:'Range',       min:-80, max:-5,   val:-60,  step:1,   unit:' dB', rt:true,  desc:'Maximum gain reduction applied by the gate' },
      { id:'gateAttack',    label:'Attack',      min:0,   max:500,  val:5,    step:1,   unit:' ms', rt:true,  desc:'Time for gate to open on signal detection' },
      { id:'gateRelease',   label:'Release',     min:50,  max:2000, val:200,  step:10,  unit:' ms', rt:true,  desc:'Time for gate to close after signal drops' },
      { id:'gateHold',      label:'Hold',        min:0,   max:500,  val:50,   step:1,   unit:' ms', rt:true,  desc:'Hold time before release phase begins' },
      { id:'gateLookahead', label:'Lookahead',   min:0,   max:50,   val:5,    step:1,   unit:' ms', rt:false, desc:'Lookahead window for predictive gating' },
    ],
    nr: [
      { id:'nrAmount',      label:'NR Amount',   min:0,   max:100,  val:78,   step:1,   unit:'%',   rt:false, desc:'Spectral noise reduction strength' },
      { id:'nrSensitivity', label:'Sensitivity', min:0,   max:100,  val:60,   step:1,   unit:'%',   rt:false, desc:'Noise floor detection sensitivity' },
      { id:'nrSpectralSub', label:'Spectral Sub',min:0,   max:100,  val:50,   step:1,   unit:'%',   rt:false, desc:'Spectral subtraction strength' },
      { id:'nrFloor',       label:'NR Floor',    min:-96, max:-30,  val:-72,  step:1,   unit:' dB', rt:false, desc:'Noise reduction floor limit' },
      { id:'nrSmoothing',   label:'Smoothing',   min:0,   max:100,  val:70,   step:1,   unit:'%',   rt:false, desc:'Temporal smoothing of spectral noise estimate' },
    ],
    eq: [
      { id:'eqSub',      label:'Sub',        min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true,  desc:'Sub-bass EQ (20-60 Hz)' },
      { id:'eqBass',     label:'Bass',       min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true,  desc:'Bass EQ (60-200 Hz)' },
      { id:'eqWarmth',   label:'Warmth',     min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true,  desc:'Warmth EQ (200-500 Hz)' },
      { id:'eqBody',     label:'Body',       min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true,  desc:'Body EQ (500-1k Hz)' },
      { id:'eqLowMid',   label:'Low Mid',    min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true,  desc:'Low-mid EQ (1-2 kHz)' },
      { id:'eqMid',      label:'Mid',        min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true,  desc:'Mid EQ (2-4 kHz)' },
      { id:'eqPresence', label:'Presence',   min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true,  desc:'Presence EQ (4-6 kHz)' },
      { id:'eqClarity',  label:'Clarity',    min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true,  desc:'Clarity EQ (6-10 kHz)' },
      { id:'eqAir',      label:'Air',        min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true,  desc:'Air EQ (10-16 kHz)' },
      { id:'eqBrill',    label:'Brilliance', min:-12, max:12, val:0, step:0.5, unit:' dB', rt:true,  desc:'Brilliance EQ (16-20 kHz)' },
    ],
    dyn: [
      { id:'compThresh',  label:'Threshold',  min:-60, max:0,   val:-24, step:1,   unit:' dB', rt:true,  desc:'Compressor threshold level' },
      { id:'compRatio',   label:'Ratio',      min:1,   max:20,  val:4,   step:0.5, unit:':1',  rt:true,  desc:'Compression ratio' },
      { id:'compAttack',  label:'Attack',     min:1,   max:200, val:10,  step:1,   unit:' ms', rt:true,  desc:'Compressor attack time' },
      { id:'compRelease', label:'Release',    min:10,  max:1000,val:150, step:10,  unit:' ms', rt:true,  desc:'Compressor release time' },
      { id:'compKnee',    label:'Knee',       min:0,   max:30,  val:6,   step:1,   unit:' dB', rt:true,  desc:'Compressor knee width' },
      { id:'compMakeup',  label:'Makeup',     min:0,   max:30,  val:0,   step:0.5, unit:' dB', rt:true,  desc:'Makeup gain after compression' },
      { id:'limThresh',   label:'Lim Thresh', min:-12, max:0,   val:-1,  step:0.5, unit:' dB', rt:true,  desc:'Brickwall limiter threshold' },
      { id:'limRelease',  label:'Lim Release',min:10,  max:500, val:50,  step:5,   unit:' ms', rt:true,  desc:'Limiter release time' },
    ],
    spec: [
      { id:'hpFreq',       label:'HP Freq',     min:20,   max:2000,  val:80,   step:1,   unit:' Hz', rt:true,  desc:'High-pass filter cutoff frequency' },
      { id:'hpQ',          label:'HP Q',        min:0.1,  max:10,    val:0.7,  step:0.1, unit:'',    rt:true,  desc:'High-pass filter resonance' },
      { id:'lpFreq',       label:'LP Freq',     min:4000, max:20000, val:18000,step:100, unit:' Hz', rt:true,  desc:'Low-pass filter cutoff frequency' },
      { id:'lpQ',          label:'LP Q',        min:0.1,  max:10,    val:0.7,  step:0.1, unit:'',    rt:true,  desc:'Low-pass filter resonance' },
      { id:'deEssFreq',    label:'De-ess Freq', min:2000, max:12000, val:6000, step:100, unit:' Hz', rt:true,  desc:'De-esser detection frequency' },
      { id:'deEssAmt',     label:'De-ess Amt',  min:0,    max:30,    val:0,    step:1,   unit:' dB', rt:true,  desc:'De-esser reduction amount' },
      { id:'specTilt',     label:'Spec Tilt',   min:-6,   max:6,     val:0,    step:0.5, unit:' dB', rt:true,  desc:'Spectral tilt' },
      { id:'formantShift', label:'Formant Shift',min:-6,  max:6,     val:0,    step:0.5, unit:' st', rt:false, desc:'Formant shift in semitones' },
    ],
    adv: [
      { id:'derevAmt',    label:'Dereverb',      min:0,   max:100, val:0,   step:1,   unit:'%',  rt:false, desc:'Dereverberation strength' },
      { id:'derevDecay',  label:'Rev Decay',     min:0,   max:100, val:50,  step:1,   unit:'%',  rt:false, desc:'Estimated reverb decay time reference' },
      { id:'harmRecov',   label:'Harm Recovery', min:0,   max:100, val:0,   step:1,   unit:'%',  rt:false, desc:'Harmonic recovery via neural vocoder' },
      { id:'harmOrder',   label:'Harm Order',    min:1,   max:10,  val:3,   step:1,   unit:'',   rt:false, desc:'Harmonic series order' },
      { id:'stereoWidth', label:'Stereo Width',  min:0,   max:200, val:100, step:1,   unit:'%',  rt:true,  desc:'Stereo width of output signal' },
      { id:'phaseCorr',   label:'Phase Corr',    min:0,   max:100, val:0,   step:1,   unit:'%',  rt:false, desc:'Phase correlation correction strength' },
    ],
    sep: [
      { id:'voiceIso',       label:'Voice Iso',   min:0,   max:100,  val:80,  step:1,   unit:'%',  rt:false, desc:'Voice isolation strength' },
      { id:'bgSuppress',     label:'BG Suppress', min:0,   max:100,  val:50,  step:1,   unit:'%',  rt:false, desc:'Background suppression level' },
      { id:'voiceFocusLo',   label:'Focus Lo',    min:80,  max:500,  val:120, step:10,  unit:' Hz',rt:false, desc:'Lower bound of voice focus band' },
      { id:'voiceFocusHi',   label:'Focus Hi',    min:1000,max:8000, val:3400,step:100, unit:' Hz',rt:false, desc:'Upper bound of voice focus band' },
      { id:'crosstalkCancel',label:'Crosstalk',   min:0,   max:100,  val:0,   step:1,   unit:'%',  rt:false, desc:'Crosstalk cancellation between channels' },
    ],
    out: [
      { id:'outGain',   label:'Output Gain', min:-24, max:24,  val:0,   step:0.5, unit:' dB', rt:true,  desc:'Final output gain trim' },
      { id:'dryWet',    label:'Dry/Wet',     min:0,   max:100, val:100, step:1,   unit:'%',   rt:true,  desc:'Blend between dry input and processed output' },
      { id:'ditherAmt', label:'Dither',      min:0,   max:10,  val:1,   step:0.1, unit:' bits',rt:false,desc:'Dither noise amplitude in bits' },
      { id:'outWidth',  label:'Out Width',   min:0,   max:200, val:100, step:1,   unit:'%',   rt:true,  desc:'Output stereo width' },
    ],
  };

  const TAB_PANEL_MAP = {
    gate:'tab-gate', nr:'tab-nr', eq:'tab-eq', dyn:'tab-dyn',
    spec:'tab-spec', adv:'tab-adv', sep:'tab-sep', out:'tab-out',
  };

  // ── Compute --pct ─────────────────────────────────────────────────────
  function setPct(input, s) {
    const range = s.max - s.min;
    const v = parseFloat(input.value);
    const pct = range > 0 ? ((v - s.min) / range) * 100 : 50;
    input.style.setProperty('--pct', pct.toFixed(2) + '%');
  }

  // ── Build a single .sr-row ────────────────────────────────────────────
  function buildRow(s) {
    const range = s.max - s.min;
    const initPct = range > 0 ? ((s.val - s.min) / range) * 100 : 50;

    const row = document.createElement('div');
    row.className = 'sr-row';

    // Label
    const lbl = document.createElement('label');
    lbl.className = 'sr-label';
    lbl.htmlFor = 'sl_' + s.id;
    lbl.title = s.desc || '';
    lbl.textContent = s.label;
    if (s.rt) {
      const badge = document.createElement('span');
      badge.className = 'rt-badge';
      badge.textContent = 'RT';
      lbl.appendChild(badge);
    }
    row.appendChild(lbl);

    // Range input
    const input = document.createElement('input');
    input.type = 'range';
    input.id = 'sl_' + s.id;
    input.min = s.min;
    input.max = s.max;
    input.step = s.step;
    input.value = s.val;
    input.title = s.desc || '';
    input.setAttribute('aria-label', s.label);
    input.setAttribute('aria-valuenow', s.val);
    input.setAttribute('aria-valuemin', s.min);
    input.setAttribute('aria-valuemax', s.max);
    // Assign RT (cyan) or default (red) accent via CSS class
    if (s.rt) input.classList.add('realtime');
    // Set filled track position
    input.style.setProperty('--pct', initPct.toFixed(2) + '%');

    // Live update
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      setPct(input, s);
      input.setAttribute('aria-valuenow', v);
      valEl.textContent = v + (s.unit || '');
      // Persist to VIP_PARAMS
      window.VIP_PARAMS = window.VIP_PARAMS || {};
      window.VIP_PARAMS[s.id] = v;
      // Dispatch to worklet / worker
      dispatchParam(s.id, v);
    });

    row.appendChild(input);

    // Value readout
    const valEl = document.createElement('span');
    valEl.className = 'sr-val';
    valEl.id = 'val_' + s.id;
    valEl.textContent = s.val + (s.unit || '');
    row.appendChild(valEl);

    return row;
  }

  // ── Rebuild all panels ────────────────────────────────────────────────
  function buildPanels() {
    for (const [key, sliders] of Object.entries(SLIDERS)) {
      const panelId = TAB_PANEL_MAP[key];
      const panel = document.getElementById(panelId);
      if (!panel) { console.warn('[VIP] missing panel:', panelId); continue; }

      // Clear stale content (handles double-init)
      panel.innerHTML = '';

      // Wrap in .sr for consistent gap
      const wrap = document.createElement('div');
      wrap.className = 'sr';

      for (const s of sliders) {
        wrap.appendChild(buildRow(s));
      }
      panel.appendChild(wrap);
    }
    console.info('[VIP] buildPanels: all 52 sliders rendered with .sr-row structure');
  }

  // ── Tab switching ─────────────────────────────────────────────────────
  function initTabs() {
    const tabBar = document.getElementById('tabBar');
    if (!tabBar) return;
    tabBar.addEventListener('click', e => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      const key = btn.dataset.tab;
      // Deactivate all
      tabBar.querySelectorAll('[data-tab]').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
        b.tabIndex = -1;
      });
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      // Activate target
      btn.classList.add('active');
      btn.setAttribute('aria-selected', 'true');
      btn.tabIndex = 0;
      const panel = document.getElementById(TAB_PANEL_MAP[key]);
      if (panel) panel.classList.add('active');
    });
    // Keyboard nav
    tabBar.addEventListener('keydown', e => {
      const btns = [...tabBar.querySelectorAll('[data-tab]')];
      const idx = btns.indexOf(document.activeElement);
      if (idx < 0) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); btns[(idx + 1) % btns.length].focus(); btns[(idx + 1) % btns.length].click(); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); btns[(idx - 1 + btns.length) % btns.length].focus(); btns[(idx - 1 + btns.length) % btns.length].click(); }
    });
  }

  // ── Dispatch slider value to worklet / worker ─────────────────────────
  const SLIDER_TARGETS = {
    // gate
    gateThresh:'worklet',gateRange:'worklet',gateAttack:'worklet',gateRelease:'worklet',gateHold:'worklet',gateLookahead:'local',
    // nr
    nrAmount:'both',nrSensitivity:'worker',nrSpectralSub:'worker',nrFloor:'worker',nrSmoothing:'worker',
    // eq
    eqSub:'worklet',eqBass:'worklet',eqWarmth:'worklet',eqBody:'worklet',eqLowMid:'worklet',eqMid:'worklet',
    eqPresence:'worklet',eqClarity:'worklet',eqAir:'worklet',eqBrill:'worklet',
    // dyn
    compThresh:'worklet',compRatio:'worklet',compAttack:'worklet',compRelease:'worklet',
    compKnee:'worklet',compMakeup:'worklet',limThresh:'worklet',limRelease:'worklet',
    // spec
    hpFreq:'worklet',hpQ:'worklet',lpFreq:'worklet',lpQ:'worklet',
    deEssFreq:'worklet',deEssAmt:'worklet',specTilt:'worklet',formantShift:'worker',
    // adv
    derevAmt:'worker',derevDecay:'worker',harmRecov:'worker',harmOrder:'worker',stereoWidth:'worklet',phaseCorr:'worker',
    // sep
    voiceIso:'worker',bgSuppress:'worker',voiceFocusLo:'worker',voiceFocusHi:'worker',crosstalkCancel:'worker',
    // out
    outGain:'worklet',dryWet:'worklet',ditherAmt:'worklet',outWidth:'worklet',
  };

  function dispatchParam(id, rawVal) {
    const target = SLIDER_TARGETS[id] || 'local';
    const payload = { [id]: rawVal };
    const app = window._vipApp || window.vip;
    const worklet = app?.workletNode || window._vipOrch?.workletNode;
    const worker  = app?.mlWorker  || window._vipOrch?.mlWorker;
    if ((target === 'worklet' || target === 'both') && worklet) {
      try { worklet.port.postMessage({ type: 'params', payload }); } catch(_) {}
    }
    if ((target === 'worker' || target === 'both') && worker) {
      try { worker.postMessage({ type: 'setParams', payload }); } catch(_) {}
    }
  }

  // ── Preset wiring ─────────────────────────────────────────────────────
  function initPresets() {
    document.querySelectorAll('[data-preset]').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.preset;
        const app = window._vipApp || window.vip;
        if (app && typeof app.applyPreset === 'function') {
          app.applyPreset(name);
          // Sync slider UI after preset apply
          setTimeout(syncSlidersFromVipParams, 50);
        } else {
          console.warn('[VIP] applyPreset not found on app instance');
        }
        // Visual feedback
        document.querySelectorAll('[data-preset]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        setTimeout(() => btn.classList.remove('active'), 1200);
      });
    });
  }

  // ── Sync slider UI from VIP_PARAMS (used after preset apply) ──────────
  function syncSlidersFromVipParams() {
    const params = window.VIP_PARAMS || {};
    for (const [id, val] of Object.entries(params)) {
      const input = document.getElementById('sl_' + id);
      const valEl = document.getElementById('val_' + id);
      if (!input) continue;
      const min = parseFloat(input.min), max = parseFloat(input.max);
      input.value = Math.max(min, Math.min(max, val));
      const pct = max > min ? ((val - min) / (max - min)) * 100 : 50;
      input.style.setProperty('--pct', pct.toFixed(2) + '%');
      if (valEl) {
        // Reconstruct unit from existing text
        const unit = valEl.textContent.replace(/[\d.\-]/g, '');
        valEl.textContent = val + unit;
      }
    }
  }

  // ── Canvas auto-resize ────────────────────────────────────────────────
  function resizeCanvases() {
    const canvasIds = [
      'neonVisualizer','waveformCanvas','waveformOrig','specCanvas',
      'spec3dCanvas','compCanvas','noiseCanvas',
      'abWaveCanvas','oscCanvas','specOverlayCanvas','lufsCanvas',
      'saliencyCanvas','clusterCanvas','diarCanvas',
    ];
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const cv = entry.target;
        const w = entry.contentRect.width;
        if (w > 0 && cv.width !== Math.round(w)) {
          cv.width = Math.round(w);
          // Fire custom event so visuals.js can re-draw
          cv.dispatchEvent(new CustomEvent('vip:resize', { detail: { width: cv.width } }));
        }
      }
    });
    for (const id of canvasIds) {
      const cv = document.getElementById(id);
      if (cv) ro.observe(cv);
    }
  }

  // ── Toast helper ──────────────────────────────────────────────────────
  function toast(msg, type = 'info', ms = 3000) {
    const region = document.getElementById('toastRegion');
    if (!region) return;
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    const close = document.createElement('button');
    close.className = 'toast-close';
    close.textContent = '×';
    close.addEventListener('click', () => el.remove());
    el.appendChild(close);
    region.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, ms);
  }
  window.VIP_toast = toast;

  // ── Stats toggle (mobile) ─────────────────────────────────────────────
  function initStatsToggle() {
    const btn = document.getElementById('statsToggle');
    const stats = document.getElementById('hdrStats');
    if (!btn || !stats) return;
    btn.addEventListener('click', () => {
      const expanded = stats.classList.toggle('expanded');
      btn.setAttribute('aria-expanded', expanded);
    });
  }

  // ── Startup banner dismiss ────────────────────────────────────────────
  function initBanner() {
    const close = document.getElementById('vip-startup-close');
    const banner = document.getElementById('vip-startup-banner');
    if (close && banner) {
      close.addEventListener('click', () => { banner.style.display = 'none'; });
    }
  }

  // ── UI Scale controls ─────────────────────────────────────────────────
  function initUiScale() {
    const dn   = document.getElementById('uiScaleDn');
    const up   = document.getElementById('uiScaleUp');
    const save = document.getElementById('uiScaleSave');
    const val  = document.getElementById('uiScaleVal');
    if (!dn || !up) return;
    let scale = parseFloat(localStorage.getItem('vip_ui_scale')) || 1;
    function apply(s) {
      scale = Math.max(0.5, Math.min(2, Math.round(s * 10) / 10));
      const root = document.documentElement.style;
      if (CSS.supports && CSS.supports('zoom', '1')) {
        root.zoom = String(scale);
      } else {
        root.transform = `scale(${scale})`;
        root.transformOrigin = 'top left';
        root.width = (100 / scale) + '%';
      }
      if (val) val.textContent = Math.round(scale * 100) + '%';
    }
    apply(scale);
    dn.addEventListener('click', () => apply(scale - 0.1));
    up.addEventListener('click', () => apply(scale + 0.1));
    if (save) {
      save.addEventListener('click', () => {
        localStorage.setItem('vip_ui_scale', scale);
        save.classList.add('saved');
        setTimeout(() => save.classList.remove('saved'), 1200);
        toast('UI scale saved', 'success');
      });
    }
  }

  // ── Diarization zoom controls ─────────────────────────────────────────
  function initDiarZoom() {
    const zi  = document.getElementById('diarZoomIn');
    const zo  = document.getElementById('diarZoomOut');
    const zf  = document.getElementById('diarZoomFit');
    if (zi) zi.addEventListener('click', () => { if (window._diarZoom) window._diarZoom(1.5); });
    if (zo) zo.addEventListener('click', () => { if (window._diarZoom) window._diarZoom(1/1.5); });
    if (zf) zf.addEventListener('click', () => { if (window._diarZoomFit) window._diarZoomFit(); });
  }

  // ── A/B toggle ────────────────────────────────────────────────────────
  function initAB() {
    const btn   = document.getElementById('tpAB');
    const label = document.getElementById('tpABLabel');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const app = window._vipApp || window.vip;
      if (app && typeof app.toggleAB === 'function') {
        const isOrig = app.toggleAB();
        if (label) label.textContent = isOrig ? 'Original' : 'Processed';
      }
    });
  }

  // ── Overlay toggles (Spec panel) ──────────────────────────────────────
  function initOverlayToggles() {
    document.querySelectorAll('.overlay-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        btn.setAttribute('aria-pressed', btn.classList.contains('active'));
      });
    });
    document.querySelectorAll('.osc-mode').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.osc-mode').forEach(b => {
          b.classList.remove('active'); b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
        const app = window._vipApp || window.vip;
        if (app && typeof app.setOscMode === 'function') app.setOscMode(btn.dataset.mode);
      });
    });
  }

  // ── Sound mute buttons ────────────────────────────────────────────────
  function initSoundMute() {
    const grid   = document.getElementById('soundMuteGrid');
    const status = document.getElementById('soundMuteStatus');
    if (!grid) return;
    grid.querySelectorAll('.sound-mute-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        const muted = [...grid.querySelectorAll('.sound-mute-btn.active')].map(b => b.dataset.cat);
        if (status) {
          status.textContent = muted.length ? 'Muting: ' + muted.join(', ') : 'No sounds muted';
          status.classList.toggle('has-mutes', muted.length > 0);
        }
        window.VIP_MUTED_CATS = muted;
      });
    });
  }

  // ── Batch drop zone ───────────────────────────────────────────────────
  function initBatchDrop() {
    const drop = document.getElementById('batchDrop');
    if (!drop) return;
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('dragover');
      const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('audio/') || f.type.startsWith('video/'));
      if (files.length && window._vipApp && typeof window._vipApp.addBatchFiles === 'function') {
        window._vipApp.addBatchFiles(files);
      }
    });
  }

  // ── AB Overlay button ─────────────────────────────────────────────────
  function initABOverlay() {
    const btn = document.getElementById('abOverlayBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const app = window._vipApp || window.vip;
      if (app && typeof app.setABOverlay === 'function') app.setABOverlay(btn.classList.contains('active'));
    });
  }

  // ── 3D Spectrogram reset ──────────────────────────────────────────────
  function initSpec3DReset() {
    const btn = document.getElementById('spec3dResetBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const app = window._vipApp || window.vip;
      if (app && typeof app.resetSpec3D === 'function') app.resetSpec3D();
    });
  }

  // ── Custom preset save ────────────────────────────────────────────────
  function initCustomPreset() {
    const saveBtn = document.getElementById('saveCustomPresetBtn');
    const nameIn  = document.getElementById('customPresetName');
    if (!saveBtn || !nameIn) return;
    saveBtn.addEventListener('click', () => {
      const name = nameIn.value.trim();
      if (!name) { toast('Enter a preset name', 'warn'); return; }
      const app = window._vipApp || window.vip;
      if (app && typeof app.saveCustomPreset === 'function') {
        app.saveCustomPreset(name);
        toast(`Preset "${name}" saved`, 'success');
        nameIn.value = '';
      } else {
        // Fallback: snapshot current VIP_PARAMS
        const presets = JSON.parse(localStorage.getItem('vip_custom_presets') || '{}');
        presets[name] = { ...window.VIP_PARAMS };
        localStorage.setItem('vip_custom_presets', JSON.stringify(presets));
        toast(`Preset "${name}" saved locally`, 'success');
        nameIn.value = '';
      }
    });
  }

  // ── Forensic toggle ───────────────────────────────────────────────────
  function initForensic() {
    const btn  = document.getElementById('forensicToggle');
    const card = document.getElementById('forensicCard');
    if (!btn || !card) return;
    btn.addEventListener('click', () => {
      const vis = card.style.display !== 'none';
      card.style.display = vis ? 'none' : 'block';
      btn.classList.toggle('active', !vis);
    });
  }

  // ── Startup banner auto-show on errors ────────────────────────────────
  function checkStartupErrors() {
    const banner = document.getElementById('vip-startup-banner');
    const msg    = document.getElementById('vip-startup-msg');
    if (!banner || !msg) return;
    // Show if WebGPU/SAB unavailable
    const issues = [];
    if (typeof SharedArrayBuffer === 'undefined') issues.push('SharedArrayBuffer unavailable (missing COOP/COEP headers — live mode disabled)');
    if (!navigator.gpu) issues.push('WebGPU unavailable — ONNX will use WASM fallback');
    if (issues.length) {
      msg.textContent = issues.join(' · ');
      banner.style.display = 'flex';
    }
  }

  // ── 20-point Debug Audit ──────────────────────────────────────────────
  function runAudit() {
    const P = '✅', F = '❌', W = '⚠️';
    let pass = 0, fail = 0, warn = 0;
    const results = [];
    function log(status, id, msg, detail) {
      const sym = status==='pass'?P:status==='fail'?F:W;
      const line = `${sym} [${String(id).padStart(2,'0')}] ${msg}${detail?' — '+detail:''}`;
      results.push(line);
      console.log(line);
      if (status==='pass') pass++;
      else if (status==='fail') fail++;
      else warn++;
    }

    // 1. Slider count
    const sliders = document.querySelectorAll('.sr-row input[type="range"]');
    sliders.length >= 52 ? log('pass',1,`${sliders.length} sliders rendered in .sr-row`) :
      log('fail',1,`Only ${sliders.length}/52 sliders found`,'buildPanels may not have run');

    // 2. sr-row structure
    const srRows = document.querySelectorAll('.sr-row');
    srRows.length >= 52 ? log('pass',2,`${srRows.length} .sr-row elements present`) :
      log('fail',2,`${srRows.length} .sr-row elements (expected ≥52)`);

    // 3. --pct set
    let noPct = 0;
    sliders.forEach(el => { if (!el.style.getPropertyValue('--pct')) noPct++; });
    noPct === 0 ? log('pass',3,'--pct set on all sliders') :
      log('fail',3,`${noPct} sliders missing --pct`);

    // 4. RT class
    const rtSliders = document.querySelectorAll('.sr-row input[type="range"].realtime');
    rtSliders.length > 0 ? log('pass',4,`${rtSliders.length} sliders have .realtime class (cyan accent)`) :
      log('fail',4,'No .realtime sliders found');

    // 5. Tab panels
    const panels = ['tab-gate','tab-nr','tab-eq','tab-dyn','tab-spec','tab-adv','tab-sep','tab-out'];
    const missingP = panels.filter(id => !document.getElementById(id));
    missingP.length===0 ? log('pass',5,'All 8 tab panels present') :
      log('fail',5,`Missing panels: ${missingP.join(', ')}`);

    // 6. Active panel has content
    const activePanel = document.querySelector('.panel.active');
    activePanel && activePanel.querySelector('.sr-row') ? log('pass',6,'Active panel has .sr-row children') :
      log('fail',6,'Active panel has no slider rows');

    // 7. Transport controls
    const tp = ['tpPlay','tpStop','tpPause','tpAB','tpSeek','tpSpeed','tpRew','tpFwd'];
    const missingTP = tp.filter(id => !document.getElementById(id));
    missingTP.length===0 ? log('pass',7,'All transport controls present') :
      log('warn',7,`Missing: ${missingTP.join(', ')}`);

    // 8. Upload zone
    const uz = document.getElementById('uploadZone'), fi = document.getElementById('fileInput');
    uz && fi ? log('pass',8,'Upload zone + file input wired') :
      log('fail',8,`uploadZone=${!!uz} fileInput=${!!fi}`);

    // 9. AudioContext
    try { const ac=new AudioContext(); log('pass',9,`AudioContext OK (${ac.state})`); ac.close(); }
    catch(e) { log('fail',9,'AudioContext failed',e.message); }

    // 10. AudioWorklet
    typeof AudioWorkletNode !== 'undefined' ? log('pass',10,'AudioWorklet available') :
      log('fail',10,'AudioWorklet not supported');

    // 11. SharedArrayBuffer
    typeof SharedArrayBuffer !== 'undefined' ? log('pass',11,'SharedArrayBuffer available') :
      log('warn',11,'SharedArrayBuffer missing — check COOP/COEP headers');

    // 12. WebGPU
    navigator.gpu ? log('pass',12,'WebGPU present') :
      log('warn',12,'WebGPU unavailable — ONNX will use WASM');

    // 13. App instance
    const app = window._vipApp || window.vip;
    app ? log('pass',13,'App instance found (window._vipApp / window.vip)') :
      log('fail',13,'App instance not bootstrapped');

    // 14. runPipeline
    app && typeof app.runPipeline === 'function' ? log('pass',14,'runPipeline() method exists') :
      log('fail',14,'runPipeline() missing on app');

    // 15. applyPreset
    app && typeof app.applyPreset === 'function' ? log('pass',15,'applyPreset() method exists') :
      log('warn',15,'applyPreset() missing');

    // 16. encWav
    if (app && typeof app.encWav === 'function') {
      try {
        const ac = new AudioContext();
        const buf = ac.createBuffer(1,4096,44100);
        const wav = app.encWav(buf);
        ac.close();
        wav && wav.byteLength > 44 ? log('pass',16,`encWav produced ${wav.byteLength}B WAV`) :
          log('fail',16,'encWav returned empty buffer');
      } catch(e) { log('fail',16,'encWav threw',e.message); }
    } else log('warn',16,'encWav not found');

    // 17. Canvases present
    const cvIds = ['neonVisualizer','waveformCanvas','specCanvas','spec3dCanvas',
                   'compCanvas','noiseCanvas','abWaveCanvas','oscCanvas',
                   'lufsCanvas','saliencyCanvas','clusterCanvas','diarCanvas'];
    const missingCV = cvIds.filter(id => !document.getElementById(id));
    missingCV.length===0 ? log('pass',17,'All 12 canvases present') :
      log('fail',17,`Missing canvases: ${missingCV.join(', ')}`);

    // 18. Toast region
    document.getElementById('toastRegion') ? log('pass',18,'#toastRegion present') :
      log('fail',18,'#toastRegion missing');

    // 19. VIP_PARAMS populated
    window.VIP_PARAMS && Object.keys(window.VIP_PARAMS).length > 0 ?
      log('pass',19,`VIP_PARAMS has ${Object.keys(window.VIP_PARAMS).length} keys`) :
      log('fail',19,'VIP_PARAMS empty or missing');

    // 20. slider-theme.css (check for --vip-accent or .sr-row fill rule)
    let themeOK = false;
    for (const sheet of document.styleSheets) {
      try {
        if (sheet.href && (sheet.href.includes('slider-theme') || sheet.href.includes('style.css'))) {
          for (const rule of sheet.cssRules || []) {
            if (rule.cssText && (rule.cssText.includes('--pct') || rule.cssText.includes('sr-row'))) {
              themeOK = true; break;
            }
          }
        }
      } catch(_) {}
      if (themeOK) break;
    }
    themeOK ? log('pass',20,'Slider theme CSS rules detected') :
      log('warn',20,'Slider theme rules not detected — sliders may not render fills');

    // Summary
    console.log('─'.repeat(52));
    console.log(`VoiceIsolate Pro Audit: ${P}${pass} pass  ${F}${fail} fail  ${W}${warn} warn`);
    console.log('─'.repeat(52));

    window.VIP_AUDIT_RESULTS = { results, pass, fail, warn };
    return window.VIP_AUDIT_RESULTS;
  }

  window.VIP_runAudit = runAudit;

  // ── INIT ──────────────────────────────────────────────────────────────
  function init() {
    console.info('[VIP-PATCH] Initialising slider patch v3...');

    buildPanels();
    initTabs();
    initPresets();
    initStatsToggle();
    initBanner();
    initUiScale();
    initDiarZoom();
    initAB();
    initOverlayToggles();
    initSoundMute();
    initBatchDrop();
    initABOverlay();
    initSpec3DReset();
    initCustomPreset();
    initForensic();
    checkStartupErrors();
    resizeCanvases();

    // Seed VIP_PARAMS from default slider values
    window.VIP_PARAMS = window.VIP_PARAMS || {};
    for (const sliders of Object.values(SLIDERS)) {
      for (const s of sliders) {
        if (!(s.id in window.VIP_PARAMS)) window.VIP_PARAMS[s.id] = s.val;
      }
    }

    // Expose registry for audit
    window.VIP_SLIDER_REGISTRY = Object.values(SLIDERS).flat();

    // Toast boot confirmation
    toast('🔊 VoiceIsolate Pro ready', 'success', 2200);

    console.info('[VIP-PATCH] Init complete. Run VIP_runAudit() to self-test.');

    // Auto-audit in debug mode
    if (window.VIP_DEBUG) setTimeout(runAudit, 800);
  }

})();
