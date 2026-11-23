/**
 * Engineer init, ONNX provider honesty, bounded diarization, and live diagnostics.
 *
 * @jest-environment jsdom
 */
/* global document, window */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let diar;
let encodeWavArrayBuffer;
let createDspSliderRow;
let diagnostics;

beforeAll(async () => {
  diar = await import('../src/core/diarization.js');
  ({ encodeWavArrayBuffer } = await import('../src/core/WavEncoder.js'));
  ({ createDspSliderRow } = await import('../src/presentation/DspSlider.js'));
  diagnostics = await import('../src/diagnostics/LiveDiagnostics.js');
});

async function loadRegistry() {
  const cache = new Map();
  async function load(rel, ctx) {
    const fullPath = path.resolve(ROOT, rel);
    if (cache.has(fullPath)) return cache.get(fullPath);
    const mod = new vm.SourceTextModule(fs.readFileSync(fullPath, 'utf8'), {
      identifier: fullPath,
      context: ctx,
    });
    cache.set(fullPath, mod);
    await mod.link(async (specifier) => {
      const resolved = path.resolve(path.dirname(fullPath), specifier);
      return load(path.relative(ROOT, resolved), ctx);
    });
    await mod.evaluate();
    return mod;
  }
  const ctx = vm.createContext({ console, window: {} });
  const sliderMap = await load('public/app/slider-map.js', ctx);
  return sliderMap.namespace.SLIDER_REGISTRY;
}

describe('Engineer shell contract', () => {
  const html = read('public/app/index.html');
  const app = read('public/app/app.js');
  const audit = read('public/app/debug-audit.js');

  test('eight panels and transport controls are in the Engineer document', () => {
    for (const id of ['tab-gate', 'tab-nr', 'tab-eq', 'tab-dyn', 'tab-spec', 'tab-adv', 'tab-sep', 'tab-out']) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const id of ['tpPlay', 'tpStop', 'tpPause', 'tpAB', 'tpSeek', 'tpSpeed', 'tpRew', 'tpFwd']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test('bootstrap keeps the instance and publishes a ready promise', () => {
    expect(app).toContain('window.VIP_engineerReady = new Promise');
    expect(app).toContain('app._bootError = e');
    expect(app).toContain("console.error('[app] init failed:'");
    expect(audit).toContain('VIP_engineerReady');
    expect(audit).not.toContain('ONNX will prefer GPU');
  });

  test('runPipeline and encWav stay on the application class', () => {
    expect(app).toMatch(/async runPipeline\s*\(/);
    expect(app).toMatch(/encWav\(buf\)/);
    expect(app).toContain('encodeWavArrayBuffer');
    expect(app).toContain('this.forensicLog = []');
  });

  test('whisper mode is addressable as a mounted control', () => {
    expect(app).toContain("row.id = 'sl_whisperMode'");
    expect(app).toContain("row.dataset.sliderId = 'whisperMode'");
  });
});

describe('slider controls drive parameters', () => {
  test('every registry entry mounts with bounds, a label, and a parameter write', async () => {
    const registry = await loadRegistry();
    expect(registry).toHaveLength(67);
    const params = {};
    document.body.replaceChildren();
    for (const spec of registry) {
      expect(Number.isFinite(spec.min)).toBe(true);
      expect(Number.isFinite(spec.max)).toBe(true);
      expect(spec.max).toBeGreaterThanOrEqual(spec.min);
      if (spec.id === 'whisperMode') {
        const group = document.createElement('div');
        group.id = 'sl_whisperMode';
        group.dataset.sliderId = 'whisperMode';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', spec.label);
        document.body.appendChild(group);
        continue;
      }
      const built = createDspSliderRow({
        spec,
        document,
        onChange: (id, value) => { params[id] = value; },
      });
      const row = built.row;
      document.body.appendChild(row);
      const range = row.querySelector('input[type="range"]');
      expect(range).not.toBeNull();
      expect(range.id).toBe(`sl_${spec.id}`);
      expect(range.min).toBe(String(spec.min));
      expect(range.max).toBe(String(spec.max));
      expect(range.getAttribute('aria-label') || range.getAttribute('aria-labelledby') || row.getAttribute('aria-label') || row.querySelector('label')?.textContent).toBeTruthy();
      expect(range.style.getPropertyValue('--pct')).not.toBe('');
      const current = Number(range.value);
      const target = current === spec.min ? spec.max : spec.min;
      if (target !== current) {
        range.value = String(target);
        range.dispatchEvent(new Event('input', { bubbles: true }));
        expect(params[spec.id]).toBeCloseTo(Number(range.value), 5);
      }
    }
    const mountedIds = new Set(
      [...document.querySelectorAll('[data-slider-id]')].map((el) => el.dataset.sliderId),
    );
    expect(mountedIds.size).toBe(67);
    expect(document.querySelectorAll('input[type="range"]').length).toBe(66);
  });
});

describe('encWav encoding', () => {
  test('encodes a mono buffer to a RIFF wav', () => {
    const samples = new Float32Array(480);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.2;
    const wav = encodeWavArrayBuffer([samples], 48000, { bitDepth: 16, ditherAmt: 0 });
    const bytes = new Uint8Array(wav.buffer || wav);
    const header = String.fromCharCode(...bytes.slice(0, 4));
    expect(header).toBe('RIFF');
    expect(bytes.length).toBeGreaterThan(44);
  });
});

describe('bounded diarization', () => {
  test('a 262.4 s silent 48 kHz channel stays inside the frame cap', () => {
    const samples = new Float32Array(12_595_200);
    const started = Date.now();
    const segments = diar.diarizeChannel(samples, 48000);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(segments).toEqual([]);
    expect(segments.stats.frames).toBeGreaterThan(0);
    expect(segments.stats.frames).toBeLessThanOrEqual(diar.MAX_DIARIZATION_FRAMES);
    expect(segments.stats.truncated).toBe(false);
    expect(segments.stats.degraded).toBe(true);
  }, 15000);

  test('an aborted signal throws AbortError before clustering', () => {
    const signal = new AbortController();
    signal.abort();
    const samples = new Float32Array(48000);
    expect(() => diar.diarizeChannel(samples, 48000, { signal: signal.signal })).toThrow(/abort/i);
  });

  test('a tiny budget returns partial work instead of hanging', () => {
    const samples = new Float32Array(48000 * 4);
    for (let i = 0; i < samples.length; i++) samples[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / 48000);
    const segments = diar.diarizeChannel(samples, 48000, { budgetMs: 0.01, maxFrames: 64 });
    expect(Array.isArray(segments)).toBe(true);
    expect(segments.stats.frames).toBeLessThanOrEqual(64);
    expect(segments.stats.truncated).toBe(true);
  });
});

describe('live diagnostics', () => {
  beforeEach(() => {
    // Reset both containers the panel touches: body (panel root) and head
    // (injected stylesheet). ensureStyle() appends to head while the tests
    // only cleared body, so the stylesheet leaked across tests and the
    // engineer-only path was never exercised on a fresh mount.
    document.body.replaceChildren();
    document.getElementById('vip-live-diagnostics-style')?.remove();
    diagnostics.clearLiveDiagnostics();
  });

  test('both pages mount the shared panel and logs omit raw audio', async () => {
    expect(read('public/landing.js')).toContain("mountLiveDiagnostics('stems')");
    expect(read('public/app/index.html')).toContain("mountLiveDiagnostics('engineer')");
    document.body.replaceChildren();
    diagnostics.clearLiveDiagnostics();
    diagnostics.mountLiveDiagnostics('stems');
    const pcm = new Float32Array([0.1, -0.2, 0.3]);
    diagnostics.vipLog('info', 'ingest.decoded', { frames: 3, samples: pcm }, { page: 'stems' });
    diagnostics.vipLog('error', 'pipeline.failed', { message: 'decode failed' }, { page: 'stems' });
    const entries = diagnostics.getLiveDiagnostics();
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries[0].level).toBe('info');
    expect(entries[0].detail.samples).toEqual({ type: 'Float32Array', length: 3 });
    const pcmList = Array.from({ length: 32 }, (_, i) => i / 32);
    diagnostics.vipLog('info', 'ingest.raw', { data: pcmList }, { page: 'stems' });
    const raw = diagnostics.getLiveDiagnostics().find((entry) => entry.event === 'ingest.raw');
    expect(raw.detail.data).toEqual({ type: 'number[]', length: 32 });
    const text = JSON.stringify(entries);
    expect(text).not.toContain('0.1');
    const panel = document.getElementById('vip-live-diagnostics');
    expect(panel).not.toBeNull();
    expect(panel.dataset.page).toBe('stems');
    expect(panel.querySelector('[role="log"]')).not.toBeNull();
    diagnostics.mountLiveDiagnostics('engineer');
    expect(panel.dataset.page).toBe('engineer');
    diagnostics.clearLiveDiagnostics();
    expect(diagnostics.getLiveDiagnostics()).toEqual([]);
  });

  test('the engineer panel docks below the sticky header, clear of the transport controls', () => {
    diagnostics.mountLiveDiagnostics('engineer');
    const style = document.getElementById('vip-live-diagnostics-style');
    expect(style).not.toBeNull();
    // Parse-level assertions, not substring matching: a substring check
    // passes while the rule is nested inside another rule and never applies
    // (PR #953 round 6). The stylesheet must parse, and the engineer rule
    // must exist as a top-level sibling rule AFTER the base rule.
    expect(style.sheet).not.toBeNull();
    const rules = Array.from(style.sheet.cssRules);
    const baseRule = rules.find(
      (rule) => rule.selectorText === '#vip-live-diagnostics',
    );
    const engineerRule = rules.find(
      (rule) => rule.selectorText === '#vip-live-diagnostics[data-page="engineer"]',
    );
    expect(baseRule).toBeDefined();
    expect(engineerRule).toBeDefined();
    expect(rules.indexOf(engineerRule)).toBeGreaterThan(rules.indexOf(baseRule));
    // Other pages keep the existing bottom-right dock.
    expect(baseRule.style.getPropertyValue('position')).toBe('fixed');
    expect(baseRule.style.getPropertyValue('right')).toBe('12px');
    expect(baseRule.style.getPropertyValue('bottom')).toBe('12px');
    // Engineer page: anchored below the sticky header (its real height is
    // published as --vip-hdr-h by engineer-console.js; 48px fallback
    // matches the shell convention) with the bottom offset cleared.
    expect(engineerRule.style.getPropertyValue('top')).toContain('var(--vip-hdr-h');
    expect(engineerRule.style.getPropertyValue('top')).toContain('12px');
    expect(engineerRule.style.getPropertyValue('bottom')).toBe('auto');
    const panel = document.getElementById('vip-live-diagnostics');
    expect(panel).not.toBeNull();
    expect(panel.dataset.page).toBe('engineer');
    // Collapse/toggle behavior is unchanged: collapsed by default.
    expect(panel.dataset.collapsed).toBe('true');
    // NOTE: jsdom in this suite does not cascade the injected <style> element
    // into getComputedStyle, so the geometric half of this (computed top/bottom
    // and no overlap with .transport-card or the header) is covered by the
    // browser shell QA (pnpm test:shell-qa), not asserted here.
  });

  test('the stems panel docks below the sticky landing header, clear of the play button', () => {
    diagnostics.mountLiveDiagnostics('stems');
    const style = document.getElementById('vip-live-diagnostics-style');
    expect(style).not.toBeNull();
    // Parse-level assertions, not substring matching: a substring check
    // passes while the rule is nested inside another rule and never applies
    // (PR #953 round 6). The stylesheet must parse, and the stems rule
    // must exist as a top-level sibling rule AFTER the base rule.
    expect(style.sheet).not.toBeNull();
    const rules = Array.from(style.sheet.cssRules);
    const baseRule = rules.find(
      (rule) => rule.selectorText === '#vip-live-diagnostics',
    );
    const stemsRule = rules.find(
      (rule) => rule.selectorText === '#vip-live-diagnostics[data-page="stems"]',
    );
    expect(baseRule).toBeDefined();
    expect(stemsRule).toBeDefined();
    expect(rules.indexOf(stemsRule)).toBeGreaterThan(rules.indexOf(baseRule));
    // The base rule is unchanged: other pages keep the bottom-right dock.
    expect(baseRule.style.getPropertyValue('position')).toBe('fixed');
    expect(baseRule.style.getPropertyValue('right')).toBe('12px');
    expect(baseRule.style.getPropertyValue('bottom')).toBe('12px');
    // Stems page: anchored below the landing header. The fallback is the
    // 52px one-row header; --vip-hdr-h is the measured height once the
    // header wraps. The bottom offset is cleared so the open panel cannot
    // cover the play button in #landingTransport.
    expect(stemsRule.style.getPropertyValue('top')).toContain('var(--vip-hdr-h');
    expect(stemsRule.style.getPropertyValue('top')).toContain('52px');
    expect(stemsRule.style.getPropertyValue('top')).toContain('12px');
    expect(stemsRule.style.getPropertyValue('bottom')).toBe('auto');
    const panel = document.getElementById('vip-live-diagnostics');
    expect(panel).not.toBeNull();
    expect(panel.dataset.page).toBe('stems');
    // Collapse/toggle behavior is unchanged: collapsed by default.
    expect(panel.dataset.collapsed).toBe('true');
    // NOTE: jsdom in this suite does not cascade the injected <style> element
    // into getComputedStyle, so the geometric half of this (computed top/bottom
    // and no overlap with #landingTransport or the header) is covered by the
    // browser shell QA (pnpm test:shell-qa), not asserted here.
  });
});

describe('ONNX status honesty', () => {
  test('a WASM retry is unverified until the session exists', async () => {
    const { applyMlWorkerMessage, getOrtStatus, setOrtStatus } = await import('../src/core/OrtStatus.js');
    setOrtStatus({
      provider: 'probing',
      providerVerified: false,
      runtimeLoaded: true,
      detail: null,
      modelsLoaded: [],
    });
    applyMlWorkerMessage({
      type: 'stage',
      stage: 'ort-fallback',
      backend: 'wasm',
      label: 'WebGPU failed — local WASM retry',
    });
    expect(getOrtStatus().providerVerified).toBe(false);
    expect(getOrtStatus().provider).toBe('probing');
    applyMlWorkerMessage({ type: 'ort-provider', backend: 'wasm', providerVerified: true });
    expect(getOrtStatus()).toMatchObject({ provider: 'wasm', providerVerified: true });
  });
});

describe('VoiceIsolatePro pipeline execution', () => {
  const getAppCode = require('./helpers/get-app-code');
  let VoiceIsolatePro;

  beforeAll(() => {
    const exportsObj = {};
    const moduleObj = { exports: exportsObj };
    const wrapper = new Function('module', 'exports', 'window', 'document', 'globalThis', getAppCode());
    wrapper(moduleObj, exportsObj, window, document, globalThis);
    VoiceIsolatePro = moduleObj.exports;
  });

  test('constructs forensicLog, encodes through encWav, and runPipeline exits without audio', async () => {
    const vip = new VoiceIsolatePro();
    expect(Array.isArray(vip.forensicLog)).toBe(true);
    expect(typeof vip.runPipeline).toBe('function');
    const samples = new Float32Array(480);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.2;
    const wav = vip.encWav({
      numberOfChannels: 1,
      sampleRate: 48000,
      getChannelData: () => samples,
    });
    expect(String.fromCharCode(...new Uint8Array(wav).slice(0, 4))).toBe('RIFF');

    vip._fileSeq = 2;
    vip.ensureDecoded = jest.fn();
    await expect(vip.runPipeline(1)).resolves.toBeUndefined();
    expect(vip.ensureDecoded).not.toHaveBeenCalled();
    expect(vip.isProcessing).toBe(false);

    vip._fileSeq = 3;
    vip.origBuffer = null;
    vip.inputBuffer = null;
    vip.ensureDecoded = jest.fn(async () => null);
    await expect(vip.runPipeline(3)).resolves.toBeUndefined();
    expect(vip.ensureDecoded).toHaveBeenCalledWith(3);
    expect(vip.isProcessing).toBe(false);
  });
});
