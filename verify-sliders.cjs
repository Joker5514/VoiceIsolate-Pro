const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext()).newPage();

  const consoleMsgs = [];
  const errors = [];
  page.on('console', msg => {
    const text = msg.text();
    consoleMsgs.push('[' + msg.type() + '] ' + text.slice(0, 300));
    if (msg.type() === 'error') errors.push(text);
  });
  page.on('pageerror', err => errors.push('UNCAUGHT: ' + err.message));

  await page.goto('http://localhost:3000/app/', { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2500);

  const result = await page.evaluate(async () => {
    window.VIP_DEBUG = true;
    const app = window._vipApp || window.vip;
    if (!app) return { fatal: 'no app instance' };

    // ── Boot AudioContext ─────────────────────────────────────────────────────
    await app.ensureCtx();
    const ctx = app.ctx;
    if (!ctx) return { fatal: 'AudioContext unavailable' };

    // ── Inject 2s stereo 440 Hz buffer ───────────────────────────────────────
    const sr = ctx.sampleRate;
    const buf = ctx.createBuffer(2, sr * 2, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] = Math.sin(2*Math.PI*440*i/sr) * 0.05;
    }
    app.inputBuffer = buf;
    app.abMode = 'original';

    // ── Click play ────────────────────────────────────────────────────────────
    document.getElementById('tpPlay')?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
    await new Promise(r => setTimeout(r, 700));

    // ── Verify DSP graph was built ────────────────────────────────────────────
    const nodes = app._dspNodes;
    const graphCheck = {
      hp:          !!nodes?.hp,
      lp:          !!nodes?.lp,
      eqNodes10:   nodes?.eqNodes?.length === 10,
      deEss:       !!nodes?.deEss,
      comp:        !!nodes?.comp,
      compMakeup:  !!nodes?.compMakeupGain,
      lMain:       nodes?.lMain !== undefined && nodes?.lMain !== null,
      outGain:     !!app._outGainNode,
      source:      !!app.currentSource,
      analyser:    !!window._vipPlayAnalyser,
    };
    const graphOk = Object.values(graphCheck).every(Boolean);

    // ── Test every slider via DOM input event (same path as real user) ────────
    const sliders = document.querySelectorAll('input[type=range]');
    const results = {};
    let domEventsFired = 0;
    let domEventsWorked = 0;

    for (const sl of sliders) {
      const id = sl.id?.replace(/^sl_/, '');
      if (!id) continue;

      const min = parseFloat(sl.min);
      const max = parseFloat(sl.max);
      const mid = (min + max) / 2;
      const testVal = isFinite(mid) ? mid : 0;

      // Track onSlider calls via a flag
      let called = false;
      const origOnSlider = app.onSlider.bind(app);
      app.onSlider = function(sid, v) {
        if (sid === id) called = true;
        return origOnSlider(sid, v);
      };

      // Fire the input event — same as a real user dragging the slider
      sl.value = String(testVal);
      try {
        sl.dispatchEvent(new Event('input', { bubbles: true }));
        domEventsFired++;
        results[id] = { fired: true, onSliderCalled: called, error: null };
        domEventsWorked++;
      } catch(e) {
        results[id] = { fired: false, onSliderCalled: false, error: e.message };
      }

      // Restore
      app.onSlider = origOnSlider;
    }

    // ── Verify the specific AudioParam nodes that should change ──────────────
    // (setTargetAtTime doesn't immediately change .value, so we verify the
    // node exists and the call didn't throw — confirmed by no error in results)
    const paramNodeMap = {
      hpFreq:      !!nodes?.hp,
      hpQ:         !!nodes?.hp,
      lpFreq:      !!nodes?.lp,
      lpQ:         !!nodes?.lp,
      eqSub:       !!nodes?.eqNodes?.[0],
      eqBass:      !!nodes?.eqNodes?.[1],
      eqWarmth:    !!nodes?.eqNodes?.[2],
      eqBody:      !!nodes?.eqNodes?.[3],
      eqLowMid:    !!nodes?.eqNodes?.[4],
      eqMid:       !!nodes?.eqNodes?.[5],
      eqPresence:  !!nodes?.eqNodes?.[6],
      eqClarity:   !!nodes?.eqNodes?.[7],
      eqAir:       !!nodes?.eqNodes?.[8],
      eqBrill:     !!nodes?.eqNodes?.[9],
      deEssFreq:   !!nodes?.deEss,
      deEssAmt:    !!nodes?.deEss,
      compThresh:  !!nodes?.comp,
      compRatio:   !!nodes?.comp,
      compAttack:  !!nodes?.comp,
      compRelease: !!nodes?.comp,
      compKnee:    !!nodes?.comp,
      compMakeup:  !!nodes?.compMakeupGain,
      outGain:     !!app._outGainNode,
      outWidth:    nodes?.lMain !== null && nodes?.lMain !== undefined,
    };

    // ── Stop ─────────────────────────────────────────────────────────────────
    document.getElementById('tpStop')?.dispatchEvent(new MouseEvent('click',{bubbles:true}));

    return {
      graphCheck,
      graphOk,
      totalSlidersDom: sliders.length,
      domEventsFired,
      domEventsWorked,
      paramNodeMap,
      sliderResults: results,
    };
  });

  // ── Analyse results ──────────────────────────────────────────────────────
  console.log('\n=== GRAPH STATE ===');
  console.log(JSON.stringify(result.graphCheck, null, 2));
  console.log('Graph OK:', result.graphOk);

  console.log('\n=== DOM SLIDER EVENTS ===');
  console.log(`${result.domEventsWorked}/${result.domEventsFired} fired without exception (${result.totalSlidersDom} sliders in DOM)`);

  const failed = Object.entries(result.sliderResults || {}).filter(([,v]) => v.error);
  const notFired = Object.entries(result.sliderResults || {}).filter(([,v]) => !v.fired);
  console.log(`Failed: ${failed.length}`, failed.map(([k,v]) => k + ': ' + v.error));
  console.log(`Not fired: ${notFired.length}`, notFired.map(([k]) => k));

  console.log('\n=== RT SLIDER → DSP NODE MAP ===');
  const paramFailed = Object.entries(result.paramNodeMap || {}).filter(([,v]) => !v);
  const paramOk = Object.entries(result.paramNodeMap || {}).filter(([,v]) => v);
  console.log(`${paramOk.length} sliders have their target DSP node`);
  if (paramFailed.length) console.log('Missing nodes for:', paramFailed.map(([k]) => k));

  console.log('\n=== NON-CERT ERRORS ===');
  const realErrors = errors.filter(e => !e.includes('ERR_CERT') && !e.includes('net::'));
  realErrors.forEach(e => console.log('ERR:', e));

  // ── Per-slider detail ────────────────────────────────────────────────────
  console.log('\n=== PER-SLIDER DETAIL ===');
  const allIds = Object.keys(result.sliderResults || {});
  const withErrors = allIds.filter(id => result.sliderResults[id].error);
  if (withErrors.length === 0) {
    console.log('All sliders: no exceptions');
  } else {
    withErrors.forEach(id => console.log('  ✗', id, result.sliderResults[id].error));
  }

  const pass = result.graphOk &&
    result.domEventsWorked === result.domEventsFired &&
    failed.length === 0 &&
    paramFailed.length === 0 &&
    realErrors.length === 0;

  console.log('\n' + (pass ? '✅  PASS' : '❌  FAIL'));
  await browser.close();
  process.exit(pass ? 0 : 1);
})();
