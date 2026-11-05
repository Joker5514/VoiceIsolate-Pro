/**
 * Cross-cutting line 190 — every enabled Engineer control executes real
 * processing (and the "truthful capabilities" half is pinned by the
 * tier/capability tests elsewhere).
 *
 * Two execution paths exist, and every registry slider must reach one:
 *   - ML path: buildMlProcessingConfig carries the id into the
 *     Process-time snapshot sent to MLWorker (spectral / postStem /
 *     export sections);
 *   - Live-Mix path: EngineerModeBridge's PARAM_MAP maps the id to a
 *     real PlaybackMixer call (gate/EQ/comp/limiter/filters/de-ess/
 *     output). The bridge is parsed, not imported, because importing
 *     it pulls AudioContext-dependent modules into Node; the key
 *     extraction below pins the map's coverage, and the mixer methods
 *     themselves are covered by the bridge/mixer tests.
 *
 * This is the dead-control detector: the "Save Custom Preset" button
 * shipped dead once (VIP-021 round 2). A registry id with no execution
 * path fails here instead of shipping silently.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let SLIDER_REGISTRY;
let schema;

async function loadBrowserModule(relPath, ctx, cache = new Map()) {
  const fullPath = path.resolve(__dirname, '..', relPath);
  if (cache.has(fullPath)) return cache.get(fullPath);
  const src = fs.readFileSync(fullPath, 'utf8');
  const mod = new vm.SourceTextModule(src, { identifier: fullPath, context: ctx });
  cache.set(fullPath, mod);
  await mod.link(async (specifier) => {
    const resolved = specifier.startsWith('/src/')
      ? path.resolve(__dirname, '..', specifier.slice(1))
      : path.resolve(path.dirname(fullPath), specifier);
    const relResolved = path.relative(path.resolve(__dirname, '..'), resolved);
    return loadBrowserModule(relResolved, ctx, cache);
  });
  await mod.evaluate();
  return mod;
}

function paramMapKeys() {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/pipeline/EngineerModeBridge.js'), 'utf8');
  const block = src.slice(src.indexOf('const PARAM_MAP'), src.indexOf('};', src.indexOf('const PARAM_MAP')));
  const keys = [];
  for (const m of block.matchAll(/^\s{2}([A-Za-z_$][\w$]*):/gm)) keys.push(m[1]);
  return new Set(keys);
}

beforeAll(async () => {
  const ctx = vm.createContext({ console });
  const sliderMap = await loadBrowserModule('public/app/slider-map.js', ctx);
  SLIDER_REGISTRY = sliderMap.namespace.SLIDER_REGISTRY;
  schema = await import('../src/core/ParameterSchema.js');
});

test('every registry slider id reaches an execution path (ML snapshot or Live-Mix)', () => {
  // Non-vacuous guard: the inventory test pins 67, but this suite must
  // not pass on an empty registry if that test ever stops running.
  expect(SLIDER_REGISTRY.length).toBe(67);
  const ml = new Set([...schema.ML_SPECTRAL_PARAM_IDS, ...schema.ML_POST_STEM_PARAM_IDS, ...schema.EXPORT_PARAM_IDS]);
  const rt = new Set(schema.LIVE_MIX_PARAM_IDS);
  const dead = SLIDER_REGISTRY.map((s) => s.id).filter((id) => !ml.has(id) && !rt.has(id));
  expect(dead).toEqual([]);
});

test('every Live-Mix id has a bridge PARAM_MAP entry (a real mixer call)', () => {
  const keys = paramMapKeys();
  const unmapped = schema.LIVE_MIX_PARAM_IDS.filter((id) => !keys.has(id));
  expect(unmapped).toEqual([]);
});

test('every ML snapshot id actually carries a caller-supplied value into the config', () => {
  const ml = [...schema.ML_SPECTRAL_PARAM_IDS, ...schema.ML_POST_STEM_PARAM_IDS, ...schema.EXPORT_PARAM_IDS];
  const values = {};
  const wanted = new Map();
  for (const id of ml) {
    const spec = schema.getParamSpec(id);
    const v = spec.default !== spec.max ? spec.max : spec.min;
    values[id] = v;
    wanted.set(id, v);
  }
  const cfg = schema.buildMlProcessingConfig(values);
  const carried = { ...cfg.spectral, ...cfg.postStem, ...cfg.export, ...cfg.liveOnly };
  for (const [id, v] of wanted) {
    expect(carried[id]).toBe(v);
  }
});
