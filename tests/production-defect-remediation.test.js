/**
 * @jest-environment jsdom
 *
 * Production defects found on VoiceIsolate-Pro v25.0.2 (2026-11-07).
 * Locks the repaired contracts. Does not hardcode a passing debug audit.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stepOf(src, id) {
  const re = new RegExp(`id\\s*:\\s*['"]${id}['"][\\s\\S]{0,320}?step\\s*:\\s*(-?[0-9.]+)`);
  const match = src.match(re);
  if (!match) throw new Error(`step for ${id} not found`);
  return Number(match[1]);
}

const ADVERTISED = [
  ['gateThresh', -42, 1],
  ['nrAmount', 52, 1],
  ['gateRelease', 200, 10],
  ['nrSensitivity', 48, 1],
  ['nrFloor', -68, 1],
  ['nrSmoothing', 32, 1],
  ['compThresh', -24, 1],
];

describe('defect 03 — reset values stay on the advertised grid', () => {
  let schema;
  let normalizeSliderValue;
  let createDspSliderRow;

  beforeAll(async () => {
    schema = await import('../src/core/ParameterSchema.js');
    ({ normalizeSliderValue, createDspSliderRow } = await import('../src/presentation/DspSlider.js'));
  });

  test.each(ADVERTISED)('%s resets to %s', (id, advertised, step) => {
    const spec = schema.PARAMETER_BY_ID.get(id);
    expect(spec.default).toBe(advertised);
    expect(spec.step).toBe(step);
    expect(normalizeSliderValue(spec.default, spec)).toBe(advertised);
  });

  test('every slider keeps held state, spinbutton, and accessible value together', () => {
    const mismatches = [];
    for (const spec of schema.PARAMETER_SCHEMA) {
      const ui = createDspSliderRow({ spec });
      const expected = normalizeSliderValue(spec.default, spec);
      if (ui.value !== expected) mismatches.push(`${spec.id} held ${ui.value} expected ${expected}`);
      if (ui.number.getAttribute('aria-valuenow') !== String(ui.value)) mismatches.push(`${spec.id} spinbutton`);
      if (!String(ui.range.getAttribute('aria-valuetext') || '').includes(String(ui.value))) {
        mismatches.push(`${spec.id} range description`);
      }
      ui.dispose();
    }
    expect(mismatches).toEqual([]);
  });

  test('schema, registry, and Engineer SLIDERS share the repaired steps', () => {
    const schemaSrc = read('src/core/ParameterSchema.js');
    const registrySrc = read('public/app/slider-map.js');
    const appSrc = read('public/app/app.js');
    const ids = ['gateThresh', 'gateRelease', 'nrAmount', 'nrSensitivity', 'nrFloor', 'nrSmoothing', 'compRatio', 'compAttack', 'compThresh'];
    for (const id of ids) {
      const step = stepOf(schemaSrc, id);
      expect(stepOf(registrySrc, id)).toBe(step);
      expect(stepOf(appSrc, id)).toBe(step);
    }
  });
});

describe('defect 04 — slider display, attack, and hint sync', () => {
  let formatSliderDisplay;
  let normalizeSliderValue;
  let createDspSliderRow;
  let updateHintPanelValue;
  let schema;

  beforeAll(async () => {
    schema = await import('../src/core/ParameterSchema.js');
    ({ formatSliderDisplay, normalizeSliderValue, createDspSliderRow } = await import('../src/presentation/DspSlider.js'));
    ({ updateHintPanelValue } = await import('../src/presentation/sliderHintSync.js'));
  });

  test('Comp Ratio formats 14.6:1 and strips trailing zeros', () => {
    const spec = schema.PARAMETER_BY_ID.get('compRatio');
    expect(normalizeSliderValue(14.6, spec)).toBe(14.6);
    expect(formatSliderDisplay(14.6, spec)).toBe('14.6:1');
    expect(formatSliderDisplay(4, spec)).toBe('4:1');
  });

  test('Comp Attack accepts 80 ms inside its configured range', () => {
    const spec = schema.PARAMETER_BY_ID.get('compAttack');
    expect(spec.min).toBeLessThanOrEqual(80);
    expect(spec.max).toBeGreaterThanOrEqual(80);
    expect(normalizeSliderValue(80, spec)).toBe(80);
    expect(normalizeSliderValue(8, spec)).toBe(8);
  });

  test('range, spinbutton, and hint follow the live value', () => {
    const spec = schema.PARAMETER_BY_ID.get('compRatio');
    const ui = createDspSliderRow({ spec, value: 4 });
    const hint = document.createElement('div');
    hint.className = 'slider-hint';
    hint.innerHTML = '<div class="hint-range-meter" aria-label="stale"><div class="hint-range-thumb"></div></div>';
    ui.row.appendChild(hint);
    ui.setValue(14.6);
    expect(ui.number.getAttribute('aria-valuetext')).toBe('14.6:1');
    expect(ui.number.getAttribute('aria-valuenow')).toBe('14.6');
    expect(ui.range.getAttribute('aria-valuetext')).toContain('14.6:1');
    expect(updateHintPanelValue(hint, { min: spec.min, max: spec.max, value: 14.6, unit: spec.unit })).toBe(true);
    expect(hint.querySelector('.hint-range-meter').getAttribute('aria-label')).toContain('14.6:1');
    expect(hint.querySelector('.hint-range-meter').getAttribute('aria-label')).not.toContain('stale');
    ui.dispose();
  });

  test('locked controls expose aria-disabled', () => {
    const spec = schema.PARAMETER_BY_ID.get('nrAmount');
    const ui = createDspSliderRow({ spec, locked: true });
    expect(ui.range.getAttribute('aria-disabled')).toBe('true');
    expect(ui.number.getAttribute('aria-disabled')).toBe('true');
    ui.setLocked(false);
    expect(ui.range.getAttribute('aria-disabled')).toBe('false');
    ui.dispose();
  });
});

describe('defect 05 — debug count, audit, and status wording', () => {
  let summarizeSliderMount;
  let mountedRangeSliders;

  beforeAll(async () => {
    ({ summarizeSliderMount, mountedRangeSliders } = await import('../src/presentation/debugSliderCount.js'));
  });

  test('an empty registry cannot pass', () => {
    document.body.innerHTML = '<input type="range" data-slider-id="gateThresh" class="dsp-slider">';
    const summary = summarizeSliderMount(document, []);
    expect(summary.expected).toBeNull();
    expect(summary.ok).toBe(false);
  });

  test('count uses data-slider-id against the registry, not a hardcoded 52', () => {
    const registry = Array.from({ length: 67 }, (_, i) => ({ id: `s${i}` }));
    document.body.innerHTML = registry.map((entry) => (
      `<div data-slider-id="${entry.id}"><input type="range" class="dsp-slider" data-slider-id="${entry.id}"></div>`
    )).join('');
    const summary = summarizeSliderMount(document, registry);
    expect(summary).toEqual({ found: 67, expected: 67, ok: true });
    expect(mountedRangeSliders(document)).toHaveLength(67);
  });

  test('a short mount fails instead of reporting success', () => {
    const registry = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    document.body.innerHTML = '<input type="range" class="dsp-slider" data-slider-id="a">';
    const summary = summarizeSliderMount(document, registry);
    expect(summary.ok).toBe(false);
    expect(summary.found).toBe(1);
    expect(summary.expected).toBe(3);
  });

  test('audit and panel source stay truthful', () => {
    const audit = read('public/app/debug-audit.js');
    const menu = read('public/app/debug-menu.js');
    const css = read('public/app/debug-menu.css');
    const status = read('public/app/model-status-ui.js');
    expect(audit).not.toMatch(/EXPECTED_SLIDER_COUNT\s*=\s*52/);
    expect(audit).toMatch(/summarizeSliderMount/);
    expect(audit).toMatch(/sliderEls\.length === 0/);
    expect(menu).toMatch(/WASM fallback/);
    expect(menu).toMatch(/vip-debug-dismissed/);
    expect(menu).toMatch(/enforceDebugDismissed/);
    expect(menu).toMatch(/closest\('#dbgClose'\)/);
    expect(css).toMatch(/\.dbg-close[\s\S]*z-index:\s*5/);
    expect(css).toMatch(/pointer-events:\s*auto/);
    expect(status).toMatch(/silero_vad|BroadcastChannel\('vip-model-progress'\)/);
    expect(status).toMatch(/probes\.set\(key, 'error'\)/);
    expect(menu).not.toMatch(/\/\s*52/);
  });
});

describe('defect 06 — Advanced paints metrics', () => {
  test('toggle updates aria-expanded and calls _updateDOM', async () => {
    const { LiveMeters } = await import('../src/ui/components/LiveMeters/LiveMeters.js');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const meters = new LiveMeters(host);
    let paints = 0;
    const orig = meters._updateDOM.bind(meters);
    meters._updateDOM = () => {
      paints += 1;
      orig();
    };
    const button = host.querySelector('[data-action="toggleAdvanced"]');
    expect(button.getAttribute('type')).toBe('button');
    button.click();
    const panel = host.querySelector('#vip-meters-advanced');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panel.style.display).toBe('flex');
    expect(paints).toBe(1);
    expect(read('src/ui/components/LiveMeters/LiveMeters.js')).toMatch(/whisperRetention \?\? null/);
    host.remove();
  });
});

describe('defect 07 — vippack download is verified and attached', () => {
  test('a real pack clicks an in-document anchor', async () => {
    const util = require('util');
    const { Blob: NodeBlob } = require('buffer');
    if (typeof globalThis.TextEncoder === 'undefined') globalThis.TextEncoder = util.TextEncoder;
    if (typeof globalThis.TextDecoder === 'undefined') globalThis.TextDecoder = util.TextDecoder;
    globalThis.Blob = NodeBlob;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = () => 'blob:vip-pack-test';
    URL.revokeObjectURL = () => {};
    const { buildPackBlob, downloadPackBlob, verifyPackBlob } = await import('../src/core/ProjectPack.js');
    const blob = buildPackBlob(
      {
        format: 'vippack',
        version: 1,
        project: { name: 'Demo', description: '', savedParams: {}, sourceFileIds: ['f1'] },
        files: [{ id: 'f1', originalFilename: 'a.wav', path: 'sources/f1/a.wav' }],
      },
      [{ name: 'sources/f1/a.wav', data: new Uint8Array([9, 8, 7, 6]) }],
    );
    const integrity = await verifyPackBlob(blob);
    expect(integrity.verified).toBe(true);
    expect(integrity.files).toBe(1);
    const clicks = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click() {
      clicks.push(this.download);
    };
    try {
      const result = await downloadPackBlob(blob, 'demo.vippack');
      expect(result.downloaded).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.bytes).toBe(integrity.bytes);
      expect(result.bytes).toBeGreaterThan(12);
      expect(result.filename).toBe('demo.vippack');
      expect(clicks).toEqual(['demo.vippack']);
      expect(document.querySelector('[data-vip-download="project-pack"]')).toBeNull();
    } finally {
      HTMLAnchorElement.prototype.click = orig;
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  test('an empty blob fails before a download is claimed', async () => {
    const { downloadPackBlob } = await import('../src/core/ProjectPack.js');
    await expect(downloadPackBlob(new Blob([]), 'empty.vippack')).rejects.toThrow(/empty archive/);
  });

  test('the Engineer page has a visible pack status', () => {
    expect(read('public/app/index.html')).toMatch(/id="exportPackStatus"/);
    expect(read('src/presentation/FileLibraryUI.js')).toMatch(/archive verified/);
    expect(read('src/presentation/FileLibraryUI.js')).toMatch(/Create or select a project first/);
  });
});

describe('defect 08 — persistence, presets, and readout cards', () => {
  test('BALANCED survives a new select', async () => {
    const { bindMemoryProfileSelect, MEMORY_PROFILE_KEY } = await import('../src/core/UiPersistence.js');
    const store = new Map();
    const storage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    };
    const first = document.createElement('select');
    for (const value of ['AUTO', 'LOW', 'BALANCED', 'HIGH']) {
      const opt = document.createElement('option');
      opt.value = value;
      first.appendChild(opt);
    }
    first.value = 'AUTO';
    bindMemoryProfileSelect(first, { storage });
    first.value = 'BALANCED';
    first.dispatchEvent(new Event('change'));
    expect(storage.getItem(MEMORY_PROFILE_KEY)).toBe('BALANCED');

    const second = document.createElement('select');
    for (const value of ['AUTO', 'LOW', 'BALANCED', 'HIGH']) {
      const opt = document.createElement('option');
      opt.value = value;
      second.appendChild(opt);
    }
    second.value = 'AUTO';
    bindMemoryProfileSelect(second, { storage });
    expect(second.value).toBe('BALANCED');
  });

  test('research checkboxes restore checked', async () => {
    const { bindCheckbox, RESEARCH_ENABLE_KEY } = await import('../src/core/UiPersistence.js');
    const store = new Map();
    const storage = {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, value),
    };
    const box = document.createElement('input');
    box.type = 'checkbox';
    bindCheckbox(box, RESEARCH_ENABLE_KEY, storage);
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    const again = document.createElement('input');
    again.type = 'checkbox';
    bindCheckbox(again, RESEARCH_ENABLE_KEY, storage);
    expect(again.checked).toBe(true);
  });

  test('an existing custom preset option stays marked custom', async () => {
    const { upsertPresetOption } = await import('../src/core/CustomPresets.js');
    const select = document.createElement('select');
    const option = document.createElement('option');
    option.value = 'Booth';
    option.textContent = 'Booth';
    select.appendChild(option);
    expect(upsertPresetOption(select, 'Booth')).toBe(false);
    expect(option.dataset.custom).toBe('1');
    expect(upsertPresetOption(select, 'Night')).toBe(true);
    expect([...select.options].find((item) => item.value === 'Night').dataset.custom).toBe('1');
  });

  test('studio custom options are not hidden by the allow-list', () => {
    const tier = read('public/app/workflow-tier.js');
    expect(tier).toMatch(/const custom = opt\.dataset\?\.custom === '1'[\s\S]*?\? !!tier\.showSaveCustom/);
    expect(tier).toMatch(/saveCustom\.setAttribute\('aria-disabled'/);
    const consoleSrc = read('public/app/engineer-console.js');
    expect(consoleSrc).toMatch(/Level readout · balance with Voice Isolation/);
    expect(consoleSrc).toMatch(/Level readout · balance with BG Suppress/);
    expect(consoleSrc).toMatch(/aria-readonly/);
    expect(read('public/app/neural-console.css')).toMatch(/\.nc-level[\s\S]*pointer-events:\s*none/);
  });
});

describe('defect 01 — ECAPA fallback is named as the 24-D voiceprint', () => {
  test('fallback copy does not call itself ECAPA enrollment', () => {
    const src = read('src/presentation/TargetSpeakerUI.js');
    expect(src).toMatch(/24-D basic voiceprint/);
    expect(src).toMatch(/not ECAPA/);
    expect(src).toMatch(/A fallback enrollment is not an ECAPA enrollment/);
    expect(src).toMatch(/ECAPA unavailable:/);
    expect(src).toMatch(/enrolled with the 24-D basic voiceprint \(not ECAPA\)/);
  });
});

describe('defect 02 — Drive status names missing settings and hides secrets', () => {
  test('missing window keys are listed and secret values are not', async () => {
    const { describeDriveConfiguration } = await import('../src/core/GoogleDriveBridge.js');
    const empty = describeDriveConfiguration({});
    expect(empty.configured).toBe(false);
    expect(empty.missing).toEqual(expect.arrayContaining([
      'FIREBASE_API_KEY',
      'FIREBASE_AUTH_DOMAIN',
      'FIREBASE_PROJECT_ID',
      'FIREBASE_APP_ID',
      'GOOGLE_API_KEY',
    ]));
    expect(empty.message).toMatch(/Local WAV export still works/);
    expect(empty.message).toMatch(/GOOGLE_DRIVE\.md/);

    const secret = 'super-secret-drive-value';
    const ready = describeDriveConfiguration({
      FIREBASE_API_KEY: secret,
      FIREBASE_AUTH_DOMAIN: 'app.firebaseapp.com',
      FIREBASE_PROJECT_ID: 'voiceisolate',
      FIREBASE_APP_ID: '1:2:web:abc',
      GOOGLE_API_KEY: secret,
    });
    expect(ready.configured).toBe(true);
    expect(JSON.stringify(ready)).not.toContain(secret);
    expect(ready.optionalMissing).toEqual(['GOOGLE_OAUTH_CLIENT_ID']);

    const electron = describeDriveConfiguration({
      FIREBASE_API_KEY: secret,
      FIREBASE_PROJECT_ID: 'voiceisolate',
      FIREBASE_APP_ID: '1:2:web:abc',
      GOOGLE_API_KEY: secret,
      vipDesktop: { firebaseAuthDomain: 'app.firebaseapp.com' },
    });
    expect(electron.configured).toBe(true);
    expect(electron.missing).not.toContain('FIREBASE_AUTH_DOMAIN');
    expect(JSON.stringify(electron)).not.toContain(secret);
  });

  test('both pages paint status before a Drive action', () => {
    const landing = read('public/landing.js');
    const app = read('public/app/app.js');
    const html = read('public/app/index.html');
    expect(landing).toMatch(/showDriveConfigStatus/);
    expect(landing).toMatch(/describeDriveConfiguration/);
    expect(app).toMatch(/_paintDriveConfigStatus/);
    expect(app).toMatch(/describeDriveConfiguration\(\)/);
    expect(html).toMatch(/id="driveConfigStatus"/);
    expect(html).toMatch(/Processing never uses Drive/i);
  });
});

describe('architecture guards on this remediation', () => {
  const files = [
    'src/presentation/sliderHintSync.js',
    'src/presentation/debugSliderCount.js',
    'src/core/UiPersistence.js',
    'src/core/GoogleDriveBridge.js',
    'src/core/ProjectPack.js',
    'src/presentation/TargetSpeakerUI.js',
    'src/presentation/DspSlider.js',
    'src/presentation/FileLibraryUI.js',
    'src/ui/components/LiveMeters/LiveMeters.js',
    'public/landing.js',
    'public/app/app.js',
    'public/app/debug-menu.js',
    'public/app/debug-audit.js',
    'public/app/model-status-ui.js',
    'public/app/model-loader.js',
    'public/app/engineer-console.js',
    'public/app/research-mode.js',
  ];

  test('changed surfaces do not add a microphone capture', () => {
    for (const rel of files) {
      expect(read(rel)).not.toMatch(/getUserMedia/);
    }
  });
});
