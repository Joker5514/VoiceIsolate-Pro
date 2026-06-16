/**
 * @jest-environment jsdom
 *
 * VoiceIsolate Pro — SliderUI (Layer 4) DOM tests.
 *
 * Locks in the real-time control contract (CLAUDE.md §1/§1.1): each Live-Mix
 * slider's `input` event drives exactly one PlaybackMixer AudioParam method,
 * coalesced through a single requestAnimationFrame flush. Fast guard for the
 * "sliders aren't wired" regression that the browser E2E (landing-smoke) also
 * covers end-to-end.
 */

'use strict';

/* global document -- provided by the jsdom test environment */

let SliderUI;
let SLIDER_BINDINGS;

beforeAll(async () => {
  ({ SliderUI, SLIDER_BINDINGS } = await import('../src/presentation/SliderUI.js'));
});

/** Mixer double recording every real-time control call. */
function mockMixer() {
  return {
    calls: [],
    setNoiseReduction(v) { this.calls.push(['setNoiseReduction', v]); },
    setVoiceLevel(v) { this.calls.push(['setVoiceLevel', v]); },
    setVolume(v) { this.calls.push(['setVolume', v]); },
    setLowShelf(v) { this.calls.push(['setLowShelf', v]); },
    setHighShelf(v) { this.calls.push(['setHighShelf', v]); },
    setEqLowMid(v) { this.calls.push(['setEqLowMid', v]); },
    setEqMid(v) { this.calls.push(['setEqMid', v]); },
    setEqHighMid(v) { this.calls.push(['setEqHighMid', v]); },
    setHighpass(v) { this.calls.push(['setHighpass', v]); },
    setLowpass(v) { this.calls.push(['setLowpass', v]); },
    setCompThreshold(v) { this.calls.push(['setCompThreshold', v]); },
    setCompRatio(v) { this.calls.push(['setCompRatio', v]); },
    setCompAttack(v) { this.calls.push(['setCompAttack', v]); },
    setCompRelease(v) { this.calls.push(['setCompRelease', v]); },
    setCompKnee(v) { this.calls.push(['setCompKnee', v]); },
    setMakeupGain(v) { this.calls.push(['setMakeupGain', v]); },
  };
}

/**
 * Build the five Live-Mix sliders with the same min/max/step as the real
 * markup (public/index.html) so jsdom's native range clamping matches the
 * browser exactly.
 */
const SLIDER_SPECS = {
  noiseReductionSlider: { min: 0, max: 100, value: 100 },
  voiceLevelSlider: { min: 0, max: 200, value: 100 },
  volumeSlider: { min: 0, max: 100, value: 100 },
  eqLowSlider: { min: -24, max: 24, value: 0 },
  eqHighSlider: { min: -24, max: 24, value: 0 },
  eqLowMidSlider: { min: -24, max: 24, value: 0 },
  eqMidSlider: { min: -24, max: 24, value: 0 },
  eqHighMidSlider: { min: -24, max: 24, value: 0 },
  highpassSlider: { min: 20, max: 2000, value: 20 },
  lowpassSlider: { min: 1000, max: 20000, value: 20000 },
  compThresholdSlider: { min: -60, max: 0, value: 0 },
  compRatioSlider: { min: 1, max: 20, value: 1 },
  compAttackSlider: { min: 0, max: 200, value: 20 },
  compReleaseSlider: { min: 0, max: 1000, value: 250 },
  compKneeSlider: { min: 0, max: 40, value: 0 },
  makeupGainSlider: { min: 0, max: 24, value: 0 },
};
function buildSliders(values = {}) {
  document.body.innerHTML = '';
  for (const [id, spec] of Object.entries(SLIDER_SPECS)) {
    const el = document.createElement('input');
    el.type = 'range';
    el.id = id;
    el.min = String(spec.min);
    el.max = String(spec.max);
    el.step = '1';
    el.value = String(values[id] ?? spec.value);
    document.body.appendChild(el);
  }
}

/** Controllable rAF: queued callbacks flush only when flushRaf() is called. */
let rafQueue;
function installControllableRaf() {
  rafQueue = [];
  globalThis.requestAnimationFrame = (cb) => { rafQueue.push(cb); return rafQueue.length; };
  globalThis.cancelAnimationFrame = (id) => { rafQueue[id - 1] = null; };
}
function flushRaf() {
  const pending = rafQueue;
  rafQueue = [];
  for (const cb of pending) if (cb) cb(0);
}

describe('SliderUI', () => {
  let mixer;

  beforeEach(() => {
    installControllableRaf();
    mixer = mockMixer();
    buildSliders();
  });

  test('requires a mixer instance', () => {
    expect(() => new SliderUI(null)).toThrow(TypeError);
  });

  test('binds every present slider and initializes the graph from its value', () => {
    const ui = new SliderUI(mixer);
    const bound = ui.bind();
    expect(bound).toBe(SLIDER_BINDINGS.length); // all present
    // bind() seeds the graph from each slider's current position.
    expect(mixer.calls).toEqual([
      ['setNoiseReduction', 100],
      ['setVoiceLevel', 100],
      ['setVolume', 100],
      ['setLowShelf', 0],
      ['setHighShelf', 0],
      ['setEqLowMid', 0],
      ['setEqMid', 0],
      ['setEqHighMid', 0],
      ['setHighpass', 20],
      ['setLowpass', 20000],
      ['setCompThreshold', 0],
      ['setCompRatio', 1],
      ['setCompAttack', 20],
      ['setCompRelease', 250],
      ['setCompKnee', 0],
      ['setMakeupGain', 0],
    ]);
  });

  test('an input event drives the mapped AudioParam method in real time', () => {
    const ui = new SliderUI(mixer);
    ui.bind();
    mixer.calls.length = 0; // drop the init calls

    const noise = document.getElementById('noiseReductionSlider');
    noise.value = '40';
    noise.dispatchEvent(new Event('input'));
    expect(mixer.calls).toEqual([]); // nothing until the frame flush
    flushRaf();
    expect(mixer.calls).toEqual([['setNoiseReduction', 40]]);
  });

  test('every slider routes to its own mixer method', () => {
    const ui = new SliderUI(mixer);
    ui.bind();
    mixer.calls.length = 0;

    const drive = (id, v) => {
      const el = document.getElementById(id);
      el.value = String(v);
      el.dispatchEvent(new Event('input'));
    };
    drive('noiseReductionSlider', 10);
    drive('voiceLevelSlider', 150);
    drive('volumeSlider', 25);
    drive('eqLowSlider', -12);
    drive('eqHighSlider', 18);
    flushRaf();

    expect(mixer.calls).toEqual([
      ['setNoiseReduction', 10],
      ['setVoiceLevel', 150],
      ['setVolume', 25],
      ['setLowShelf', -12],
      ['setHighShelf', 18],
    ]);
  });

  test('rapid drag is coalesced to one flush carrying the latest value', () => {
    const ui = new SliderUI(mixer);
    ui.bind();
    mixer.calls.length = 0;

    const vol = document.getElementById('volumeSlider');
    for (const v of [90, 80, 70, 60, 55]) {
      vol.value = String(v);
      vol.dispatchEvent(new Event('input'));
    }
    expect(rafQueue.filter(Boolean).length).toBe(1); // one frame scheduled, not five
    flushRaf();
    expect(mixer.calls).toEqual([['setVolume', 55]]);
  });

  test('onChange hook fires per input with id and value', () => {
    const seen = [];
    const ui = new SliderUI(mixer, { onChange: (id, v) => seen.push([id, v]) });
    ui.bind();

    const eq = document.getElementById('eqHighSlider');
    eq.value = '6';
    eq.dispatchEvent(new Event('input'));
    expect(seen).toEqual([['eqHighSlider', 6]]);
  });

  test('absent sliders are skipped without throwing', () => {
    document.getElementById('eqLowSlider').remove();
    document.getElementById('eqHighSlider').remove();
    const ui = new SliderUI(mixer);
    expect(ui.bind()).toBe(SLIDER_BINDINGS.length - 2);
  });

  test('a missing mixer method is skipped with a warning, not a crash', () => {
    delete mixer.setVolume;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const ui = new SliderUI(mixer);
    expect(ui.bind()).toBe(SLIDER_BINDINGS.length - 1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('dispose() detaches listeners so later input is inert', () => {
    const ui = new SliderUI(mixer);
    ui.bind();
    mixer.calls.length = 0;
    ui.dispose();

    const noise = document.getElementById('noiseReductionSlider');
    noise.value = '0';
    noise.dispatchEvent(new Event('input'));
    flushRaf();
    expect(mixer.calls).toEqual([]);
  });
});
