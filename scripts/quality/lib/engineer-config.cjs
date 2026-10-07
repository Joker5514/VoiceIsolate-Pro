'use strict';
/**
 * Reproduces the Engineer Process snapshot exactly as app.js builds it:
 *   buildMlProcessingConfig(getEffectiveDspParams(<registry defaults + overrides>))
 * public/app/ is CommonJS-typed for Node, so the two ESM sources are loaded
 * from a private .mjs copy (bytes unchanged apart from the import specifier).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '../../..');
let cached = null;

async function loadModules() {
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-quality-'));
  let sliderMap;
  let calibration;
  try {
    const cal = fs.readFileSync(path.join(ROOT, 'public/app/slider-calibration.js'), 'utf8');
    const map = fs.readFileSync(path.join(ROOT, 'public/app/slider-map.js'), 'utf8')
      .replace("from './slider-calibration.js'", "from './slider-calibration.mjs'");
    fs.writeFileSync(path.join(dir, 'slider-calibration.mjs'), cal);
    fs.writeFileSync(path.join(dir, 'slider-map.mjs'), map);
    sliderMap = await import(pathToFileURL(path.join(dir, 'slider-map.mjs')).href);
    calibration = await import(pathToFileURL(path.join(dir, 'slider-calibration.mjs')).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const schema = await import(pathToFileURL(path.join(ROOT, 'src/core/ParameterSchema.js')).href);
  cached = { sliderMap, calibration, schema };
  return cached;
}

/** Registry default for every slider id. */
async function registryDefaults() {
  const { sliderMap } = await loadModules();
  const out = {};
  for (const e of sliderMap.SLIDER_REGISTRY) {
    const v = e.default ?? e.def ?? e.val ?? e.value;
    if (Number.isFinite(Number(v))) out[e.id] = Number(v);
  }
  return out;
}

/** Engineer Process snapshot for registry defaults plus `overrides` (raw UI values). */
async function engineerConfig(overrides = {}) {
  const { calibration, schema } = await loadModules();
  const raw = { ...(await registryDefaults()), ...overrides };
  const eff = calibration.getEffectiveDspParams(raw, { stereoHint: { stereoActive: false, channelDiff: 0 } });
  return schema.buildMlProcessingConfig(eff);
}

module.exports = { engineerConfig, registryDefaults };
