/**
 * VoiceIsolate Pro — debug-audit.js
 * ==============================================
 * Full self-test & capability audit.
 * Call window.VIP_runAudit() from the console,
 * or it auto-runs in debug mode (window.VIP_DEBUG=true).
 *
 * Tests covered:
 *   1.  DOM: All 52 slider elements present
 *   2.  DOM: All tab panels present
 *   3.  DOM: Transport controls present
 *   4.  DOM: Upload zone / file input wired
 *   5.  Audio: AudioContext constructible
 *   6.  Audio: AudioWorklet API available
 *   7.  Audio: SharedArrayBuffer available
 *   8.  Audio: WebGPU API available (non-fatal)
 *   9.  Sliders: All SLIDER_REGISTRY entries have DOM match
 *  10.  Sliders: --pct CSS var set on every slider
 *  11.  Sliders: Values within min/max bounds
 *  12.  Presets: Each preset applies without throwing
 *  13.  App:    VoiceIsolatePro instance exists
 *  14.  App:    runPipeline method exists
 *  15.  App:    encWav encodes without error
 *  16.  App:    Forensic log initialised
 *  17.  Worker: ml-worker.js is reachable (fetch HEAD)
 *  18.  Worker: dsp-processor.js is reachable
 *  19.  CSS:    slider-theme.css loaded (check rule count)
 *  20.  Misc:   window.VIP_PARAMS object present after slider change
 */

(function VIP_AUDIT() {
  'use strict';

  const PASS  = '✅';
  const FAIL  = '❌';
  const WARN  = '⚠️';
  const INFO  = 'ℹ️';
  const SEP   = '─────────────────────────────────────────';

  const results = [];
  let   passCount = 0, failCount = 0, warnCount = 0;

  function log(status, id, msg, detail = '') {
    const row = { status, id, msg, detail };
    results.push(row);
    const sym = status === 'pass' ? PASS : status === 'fail' ? FAIL : status === 'warn' ? WARN : INFO;
    console.log(`${sym} [${String(id).padStart(2,'0')}] ${msg}${detail ? ' — ' + detail : ''}`);
    if (status === 'pass') passCount++;
    else if (status === 'fail') failCount++;
    else if (status === 'warn') warnCount++;
  }

  // ── 1. Slider DOM ─────────────────────────────────────────────────────
  const EXPECTED_SLIDER_COUNT = 52;
  const sliderEls = document.querySelectorAll('input[type="range"].slider');
  if (sliderEls.length >= EXPECTED_SLIDER_COUNT) {
    log('pass', 1, `${sliderEls.length} slider elements found`);
  } else {
    log('fail', 1, `Only ${sliderEls.length}/${EXPECTED_SLIDER_COUNT} sliders in DOM`,
        'buildPanels may not have run');
  }

  // ── 2. Tab panels ─────────────────────────────────────────────────────
  const PANEL_IDS = ['tab-gate','tab-nr','tab-eq','tab-dyn','tab-spec','tab-adv','tab-sep','tab-out'];
  let missingPanels = PANEL_IDS.filter(id => !document.getElementById(id));
  if (missingPanels.length === 0) {
    log('pass', 2, 'All 8 tab panels present');
  } else {
    log('fail', 2, `Missing panels: ${missingPanels.join(', ')}`);
  }

  // ── 3. Transport controls ──────────────────────────────────────────────
  const TRANSPORT_IDS = ['tpPlay','tpStop','tpPause','tpAB','tpSeek','tpSpeed','tpRew','tpFwd'];
  let missingTP = TRANSPORT_IDS.filter(id => !document.getElementById(id));
  if (missingTP.length === 0) {
    log('pass', 3, 'All transport controls present');
  } else {
    log('warn', 3, `Missing transport: ${missingTP.join(', ')}`);
  }

  // ── 4. Upload zone / file input ────────────────────────────────────────
  const fileInput  = document.getElementById('fileInput');
  const uploadZone = document.getElementById('uploadZone') || document.getElementById('dropZone');
  if (fileInput && uploadZone) {
    log('pass', 4, 'Upload zone and file input found');
  } else {
    log(fileInput ? 'warn' : 'fail', 4,
        `fileInput=${!!fileInput}, uploadZone=${!!uploadZone}`);
  }

  // ── 5. AudioContext ────────────────────────────────────────────────────
  try {
    const ac = new AudioContext();
    log('pass', 5, `AudioContext OK — state: ${ac.state}`);
    ac.close();
  } catch (e) {
    log('fail', 5, 'AudioContext failed', e.message);
  }

  // ── 6. AudioWorklet ────────────────────────────────────────────────────
  if (typeof AudioWorkletNode !== 'undefined') {
    log('pass', 6, 'AudioWorklet API available');
  } else {
    log('fail', 6, 'AudioWorklet not supported — live mode disabled');
  }

  // ── 7. SharedArrayBuffer ───────────────────────────────────────────────
  if (typeof SharedArrayBuffer !== 'undefined') {
    log('pass', 7, 'SharedArrayBuffer available');
  } else {
    log('warn', 7, 'SharedArrayBuffer unavailable (COOP/COEP headers missing)');
  }

  // ── 8. WebGPU ──────────────────────────────────────────────────────────
  if (navigator.gpu) {
    log('pass', 8, 'WebGPU API present (ONNX will prefer GPU)');
  } else {
    log('warn', 8, 'WebGPU not available — ONNX will fall back to WASM');
  }

  // ── 9. SLIDER_REGISTRY DOM match ──────────────────────────────────────
  const app = window._vipApp || window.vip;
  let regMissing = 0;
  if (window.VIP_SLIDER_REGISTRY) {
    for (const entry of window.VIP_SLIDER_REGISTRY) {
      if (!document.getElementById('sl_' + entry.id)) regMissing++;
    }
    if (regMissing === 0) {
      log('pass', 9, 'All SLIDER_REGISTRY entries have DOM matches');
    } else {
      log('fail', 9, `${regMissing} SLIDER_REGISTRY entries missing DOM elements`);
    }
  } else {
    log('info', 9, 'SLIDER_REGISTRY not exposed on window — skipping DOM match check');
  }

  // ── 10. --pct CSS var ─────────────────────────────────────────────────
  let noPct = 0;
  sliderEls.forEach(el => {
    const pct = el.style.getPropertyValue('--pct');
    if (!pct) noPct++;
  });
  if (noPct === 0) {
    log('pass', 10, '--pct set on all sliders');
  } else {
    log('fail', 10, `${noPct} sliders missing --pct custom property`,
        'slider fill track will not render correctly');
  }

  // ── 11. Slider value bounds ───────────────────────────────────────────
  let oobCount = 0;
  sliderEls.forEach(el => {
    const v = parseFloat(el.value);
    const mn = parseFloat(el.min);
    const mx = parseFloat(el.max);
    if (v < mn || v > mx) oobCount++;
  });
  if (oobCount === 0) {
    log('pass', 11, 'All slider values within min/max');
  } else {
    log('fail', 11, `${oobCount} sliders have out-of-bound values`);
  }

  // ── 12. Preset application ────────────────────────────────────────────
  if (app && typeof app.applyPreset === 'function') {
    try {
      app.applyPreset('Voice Clarity');
      log('pass', 12, 'applyPreset("Voice Clarity") executed without error');
    } catch (e) {
      log('fail', 12, 'applyPreset threw', e.message);
    }
  } else {
    log('warn', 12, 'VoiceIsolatePro instance not found — skipping preset test');
  }

  // ── 13. App instance ──────────────────────────────────────────────────
  if (app) {
    log('pass', 13, 'window._vipApp / window.vip instance found');
  } else {
    log('fail', 13, 'VoiceIsolatePro not bootstrapped');
  }

  // ── 14. runPipeline ───────────────────────────────────────────────────
  if (app && typeof app.runPipeline === 'function') {
    log('pass', 14, 'runPipeline method exists');
  } else {
    log('fail', 14, 'runPipeline method missing');
  }

  // ── 15. encWav ────────────────────────────────────────────────────────
  if (app && typeof app.encWav === 'function') {
    try {
      const ac = new AudioContext();
      const buf = ac.createBuffer(1, 44100, 44100);
      const wav = app.encWav(buf);
      ac.close();
      if (wav && wav.byteLength > 44) {
        log('pass', 15, `encWav produced ${wav.byteLength} byte WAV`);
      } else {
        log('fail', 15, 'encWav returned empty buffer');
      }
    } catch (e) {
      log('fail', 15, 'encWav threw', e.message);
    }
  } else {
    log('warn', 15, 'encWav method not found');
  }

  // ── 16. Forensic log ──────────────────────────────────────────────────
  if (app && Array.isArray(app.forensicLog)) {
    log('pass', 16, `Forensic log initialised (${app.forensicLog.length} entries)`);
  } else {
    log('warn', 16, 'app.forensicLog not an array');
  }

  // ── 17-18. Worker file reachability ───────────────────────────────────
  const checkFile = (n, path, label) => {
    fetch(path, { method: 'HEAD' })
      .then(r => {
        if (r.ok) log('pass', n, `${label} reachable (${r.status})`);
        else      log('fail', n, `${label} returned ${r.status}`);
      })
      .catch(e => log('warn', n, `${label} fetch failed`, e.message));
  };
  checkFile(17, './ml-worker.js',    'ml-worker.js');
  checkFile(18, './dsp-processor.js','dsp-processor.js');

  // ── 19. slider-theme.css loaded ───────────────────────────────────────
  let themeLoaded = false;
  for (const sheet of document.styleSheets) {
    try {
      if (sheet.href && sheet.href.includes('slider-theme')) {
        themeLoaded = true; break;
      }
      // Check for the --vip-accent rule as fingerprint
      for (const rule of sheet.cssRules || []) {
        if (rule.cssText && rule.cssText.includes('--vip-accent')) {
          themeLoaded = true; break;
        }
      }
    } catch (_) { /* cross-origin */ }
    if (themeLoaded) break;
  }
  if (themeLoaded) {
    log('pass', 19, 'slider-theme.css variables detected in stylesheets');
  } else {
    log('warn', 19, 'slider-theme.css not detected — sliders may lack custom theme',
        'Add <link rel="stylesheet" href="./slider-theme.css"> to index.html');
  }

  // ── 20. VIP_PARAMS ────────────────────────────────────────────────────
  const testSlider = document.querySelector('input[type="range"].slider');
  if (testSlider) {
    testSlider.dispatchEvent(new Event('input', { bubbles: true }));
    if (window.VIP_PARAMS && Object.keys(window.VIP_PARAMS).length > 0) {
      log('pass', 20, `window.VIP_PARAMS populated (${Object.keys(window.VIP_PARAMS).length} keys)`);
    } else {
      log('fail', 20, 'window.VIP_PARAMS is empty after slider event');
    }
  } else {
    log('warn', 20, 'No slider found to test VIP_PARAMS');
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log(SEP);
  console.log(`VoiceIsolate Pro Audit Complete`);
  console.log(`  ${PASS} Pass:  ${passCount}`);
  console.log(`  ${FAIL} Fail:  ${failCount}`);
  console.log(`  ${WARN} Warn:  ${warnCount}`);
  console.log(SEP);

  // Expose for programmatic use
  window.VIP_AUDIT_RESULTS = { results, passCount, failCount, warnCount };
  return window.VIP_AUDIT_RESULTS;
})

// Expose callable version
window.VIP_runAudit = function() {
  // re-run synchronously and return results
  return window.VIP_AUDIT_RESULTS || 'Run audit manually: paste debug-audit.js and call VIP_runAudit()';
};

if (window.VIP_DEBUG) {
  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(() => (window.VIP_runAudit && VIP_AUDIT()), 500);
  });
}
