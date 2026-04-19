(function controlsDiagnosticBootstrap() {
  'use strict';

  function waitForApp(timeoutMs = 4000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (window._vipApp) return resolve(window._vipApp);
        if (Date.now() - start > timeoutMs) return reject(new Error('VoiceIsolatePro app instance not found'));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  function withMethodSpy(app, methodName, fn) {
    const original = app[methodName];
    let calls = 0;
    app[methodName] = function(...args) {
      calls += 1;
      if (typeof original === 'function') return original.apply(this, args);
      return undefined;
    };
    try {
      fn();
    } finally {
      app[methodName] = original;
    }
    return calls;
  }

  async function runControlsDiagnostic() {
    const app = await waitForApp();
    const results = [];
    const push = (ok, control, detail) => results.push({ ok: !!ok, control, detail: detail || '' });
    const must = id => {
      const el = document.getElementById(id);
      push(!!el, id, !!el ? 'present' : 'missing');
      return el;
    };

    const controls = {
      uploadZone: must('uploadZone'),
      fileInput: must('fileInput'),
      fileBtn: must('fileBtn'),
      clearFile: must('clearFile'),
      processBtn: must('processBtn'),
      saveOrigBtn: must('saveOrigBtn'),
      saveProcBtn: must('saveProcBtn'),
      tpPlay: must('tpPlay'),
      tpPause: must('tpPause'),
      tpStop: must('tpStop'),
      tpAB: must('tpAB'),
      tpScrubTrack: must('tpScrubTrack'),
      waveformCanvas: must('waveformCanvas'),
      waveformOrig: must('waveformOrig'),
      tpCur: must('tpCur'),
      tpTotal: must('tpTotal')
    };

    if (controls.tpPlay) {
      const wasDisabled = controls.tpPlay.disabled;
      controls.tpPlay.disabled = false;
      const playCalls = withMethodSpy(app, 'togglePlayback', () => controls.tpPlay.click());
      controls.tpPlay.disabled = wasDisabled;
      push(playCalls > 0, 'tpPlay click handler', playCalls > 0 ? 'togglePlayback invoked' : 'togglePlayback not invoked');
    }
    if (controls.tpPause) {
      const wasDisabled = controls.tpPause.disabled;
      controls.tpPause.disabled = false;
      const pauseCalls = withMethodSpy(app, 'pause', () => controls.tpPause.click());
      controls.tpPause.disabled = wasDisabled;
      push(pauseCalls > 0, 'tpPause click handler', pauseCalls > 0 ? 'pause invoked' : 'pause not invoked');
    }
    if (controls.tpStop) {
      const wasDisabled = controls.tpStop.disabled;
      controls.tpStop.disabled = false;
      const stopCalls = withMethodSpy(app, 'stop', () => controls.tpStop.click());
      controls.tpStop.disabled = wasDisabled;
      push(stopCalls > 0, 'tpStop click handler', stopCalls > 0 ? 'stop invoked' : 'stop not invoked');
    }
    if (controls.tpAB) {
      const abCalls = withMethodSpy(app, 'toggleAB', () => controls.tpAB.click());
      push(abCalls > 0, 'tpAB click handler', abCalls > 0 ? 'toggleAB invoked' : 'toggleAB not invoked');
    }
    if (controls.processBtn) {
      const wasDisabled = controls.processBtn.disabled;
      controls.processBtn.disabled = false;
      const processCalls = withMethodSpy(app, 'runPipeline', () => controls.processBtn.click());
      controls.processBtn.disabled = wasDisabled;
      push(processCalls > 0, 'processBtn click handler', processCalls > 0 ? 'runPipeline invoked' : 'runPipeline not invoked');
    }
    if (controls.clearFile) {
      const clearCalls = withMethodSpy(app, 'clearLoadedFile', () => controls.clearFile.click());
      push(clearCalls > 0, 'clearFile click handler', clearCalls > 0 ? 'clearLoadedFile invoked' : 'clearLoadedFile not invoked');
    }
    if (controls.fileBtn && controls.fileInput) {
      const originalClick = controls.fileInput.click;
      let fileInputClicked = 0;
      controls.fileInput.click = () => { fileInputClicked += 1; };
      controls.fileBtn.click();
      controls.fileInput.click = originalClick;
      push(fileInputClicked > 0, 'fileBtn click handler', fileInputClicked > 0 ? 'fileInput.click invoked' : 'fileInput.click not invoked');
    }
    if (controls.tpScrubTrack) {
      const originalRect = controls.tpScrubTrack.getBoundingClientRect;
      controls.tpScrubTrack.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, bottom: 0, right: 200, height: 0 });
      const seekCalls = withMethodSpy(app, 'seekTo', () => {
        controls.tpScrubTrack.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 100 }));
      });
      controls.tpScrubTrack.getBoundingClientRect = originalRect;
      push(seekCalls > 0, 'tpScrubTrack pointer handler', seekCalls > 0 ? 'seekTo invoked' : 'seekTo not invoked');
    }
    if (controls.waveformCanvas) {
      const originalRect = controls.waveformCanvas.getBoundingClientRect;
      controls.waveformCanvas.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, bottom: 0, right: 200, height: 0 });
      const seekCalls = withMethodSpy(app, 'seekTo', () => {
        controls.waveformCanvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 80 }));
      });
      controls.waveformCanvas.getBoundingClientRect = originalRect;
      push(seekCalls > 0, 'waveformCanvas click handler', seekCalls > 0 ? 'seekTo invoked' : 'seekTo not invoked');
    }
    if (controls.waveformOrig) {
      const originalRect = controls.waveformOrig.getBoundingClientRect;
      controls.waveformOrig.getBoundingClientRect = () => ({ left: 0, width: 200, top: 0, bottom: 0, right: 200, height: 0 });
      const seekCalls = withMethodSpy(app, 'seekTo', () => {
        controls.waveformOrig.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 120 }));
      });
      controls.waveformOrig.getBoundingClientRect = originalRect;
      push(seekCalls > 0, 'waveformOrig click handler', seekCalls > 0 ? 'seekTo invoked' : 'seekTo not invoked');
    }

    const sliderEls = Array.from(document.querySelectorAll('input[type="range"][data-param]'));
    push(sliderEls.length >= 52, 'slider count', 'found ' + sliderEls.length + ' sliders');
    app._sliderContextResumed = true;
    for (const slider of sliderEls.slice(0, 6)) {
      const valueEl = document.getElementById(slider.id + 'Val');
      const prev = valueEl ? valueEl.textContent : '';
      const prevParam = app.params ? app.params[slider.id] : undefined;
      const cur = parseFloat(slider.value);
      const min = parseFloat(slider.min);
      const max = parseFloat(slider.max);
      const next = Number.isFinite(cur) ? (cur < max ? cur + (Number(slider.step) || 1) : Math.max(min, cur - (Number(slider.step) || 1))) : min;
      slider.value = String(next);
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      const labelChanged = valueEl ? valueEl.textContent !== prev : false;
      const paramChanged = app.params ? app.params[slider.id] !== prevParam : false;
      const changed = labelChanged || paramChanged;
      push(changed, 'slider ' + slider.id, changed ? 'value updates reflected' : 'value did not propagate');
    }

    const bindingChecks = ['uploadZone', 'fileInput', 'fileBtn', 'clearFile', 'playBtn', 'pauseBtn', 'stopBtn', 'processBtn', 'tpAB'];
    for (const key of bindingChecks) {
      const hasBinding = !!(app._controlBindings && app._controlBindings[key] && Object.keys(app._controlBindings[key]).length > 0);
      push(hasBinding, 'binding map ' + key, hasBinding ? 'bound' : 'missing');
    }

    const passed = results.filter(r => r.ok).length;
    const failed = results.length - passed;
    const summary = { passed, failed, total: results.length, results };
    window.__vipControlsDiagnosticResult = summary;
    if (failed > 0) console.warn('[controls-test] FAIL', summary);
    else console.info('[controls-test] PASS', summary);
    return summary;
  }

  window.runControlsDiagnostic = runControlsDiagnostic;
  if (window.location.search.includes('controlsTest=1')) {
    window.addEventListener('load', () => { runControlsDiagnostic().catch(err => console.error('[controls-test]', err)); }, { once: true });
  }
})();
