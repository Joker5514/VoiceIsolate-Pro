/** @jest-environment jsdom */
/* global document, navigator, MutationObserver, Event */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let createDspSliderRow;
let initSliderTicks;
let VIPSliderAudit;

function loadSliderRegistry() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public/app/slider-map.js'), 'utf8')
    .replace(/^import\s+\{\s*calibrateRegistry\s*\}\s+from\s+'\.\/slider-calibration\.js';\s*/m, '')
    .replace(/^export\s+/gm, '')
    .concat('\nglobalThis.__SLIDER_REGISTRY__ = SLIDER_REGISTRY;');
  const scope = { calibrateRegistry: (entries) => entries, Math, Number, Object, Array };
  scope.globalThis = scope;
  vm.runInNewContext(source, scope);
  return scope.__SLIDER_REGISTRY__;
}

beforeAll(async () => {
  ({ createDspSliderRow } = await import('../src/presentation/DspSlider.js'));
  const Schema = await import('../src/core/ParameterSchema.js');
  const sliderRegistry = loadSliderRegistry();
  const source = fs.readFileSync(path.join(__dirname, '..', 'public/app/slider-ticks.js'), 'utf8')
    .replace("import { SLIDER_REGISTRY } from './slider-map.js';", 'const SLIDER_REGISTRY = globalThis.__SLIDER_REGISTRY__;')
    .replace(
      /import \{[\s\S]*?\} from '\/src\/core\/ParameterSchema\.js';/,
      `const EXPORT_PARAM_IDS = globalThis.__EXPORT_PARAM_IDS__;
const LIVE_MIX_PARAM_IDS = globalThis.__LIVE_MIX_PARAM_IDS__;
const ML_POST_STEM_PARAM_IDS = globalThis.__ML_POST_STEM_PARAM_IDS__;
const ML_SPECTRAL_PARAM_IDS = globalThis.__ML_SPECTRAL_PARAM_IDS__;`,
    )
    .replace('export function initSliderTicks()', 'function initSliderTicks()')
    .replace('export const VIPSliderAudit', 'const VIPSliderAudit')
    .concat('\nglobalThis.__initSliderTicks = initSliderTicks; globalThis.__VIPSliderAudit = VIPSliderAudit;');
  const scope = {
    __SLIDER_REGISTRY__: sliderRegistry,
    __EXPORT_PARAM_IDS__: Schema.EXPORT_PARAM_IDS,
    __LIVE_MIX_PARAM_IDS__: Schema.LIVE_MIX_PARAM_IDS,
    __ML_POST_STEM_PARAM_IDS__: Schema.ML_POST_STEM_PARAM_IDS,
    __ML_SPECTRAL_PARAM_IDS__: Schema.ML_SPECTRAL_PARAM_IDS,
    document,
    navigator,
    MutationObserver,
    Event,
    console,
  };
  scope.globalThis = scope;
  vm.runInNewContext(source, scope);
  initSliderTicks = scope.__initSliderTicks;
  VIPSliderAudit = scope.__VIPSliderAudit;
});

describe('canonical DspSlider tick wiring', () => {
  test('resolves data-slider-id, attaches once, and wraps the nested range', () => {
    document.body.innerHTML = '';
    const widget = createDspSliderRow({
      document,
      spec: {
        id: 'nrAmount', label: 'NR Amount', min: 0, max: 100,
        step: 5, default: 52, unit: '%', rt: true,
      },
      onChange: () => {},
    });
    document.body.appendChild(widget.row);
    initSliderTicks();
    initSliderTicks();
    expect(widget.range.dataset.sliderId).toBe('nrAmount');
    expect(widget.range.getAttribute('list')).toMatch(/^ticks-nrAmount-/);
    expect(widget.range.closest('.slider-tick-wrapper')).toBeTruthy();
    expect(document.querySelectorAll('datalist')).toHaveLength(1);
    widget.dispose();
  });

  test('diagnostic taxonomy resolves every canonical control to its real consumer', () => {
    expect(VIPSliderAudit.run()).toEqual([]);
  });
});
