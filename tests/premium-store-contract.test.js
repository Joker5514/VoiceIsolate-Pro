/**
 * VoiceIsolate Pro — store call contract for the premium surfaces
 *
 * premium-workspace.js shipped calls to sessionStore.setActiveProfile and
 * sessionStore.setSelection, neither of which exists on AudioSessionStore.
 * Both threw inside click handlers (profile buttons, region action palette)
 * while the parse-only and regex tests stayed green. This scans every store
 * call in the shipped consumers against the real class prototypes, and pins
 * the profile -> preset map to preset names applyPreset() actually knows.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// Which identifier names which store, per shipped consumer.
const CONSUMERS = {
  'public/app/premium-workspace.js': { sessionStore: 'session', uiStore: 'ui' },
  'public/app/lib/signal-canvas-integration.js': { store: 'session' },
  'public/landing.js': { sessionStore: 'session' },
  'public/landing-premium.js': { sessionStore: 'session', uiStore: 'ui' },
  'src/ui/layouts/WorkstationLayout.js': { 'this._uiStore': 'ui' },
  'src/ui/layouts/MobileAnalysisLayout.js': { 'this._uiStore': 'ui' },
  'src/ui/components/RegionActionPalette/RegionActionPalette.js': { uiStore: 'ui' },
};

const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

/** Every `<alias>.<method>(` / `<alias>.<method>?.(` call, with its line. */
function storeCalls(src, aliases) {
  const out = [];
  const lines = stripComments(src).split('\n');
  for (const [alias, kind] of Object.entries(aliases)) {
    const esc = alias.replace(/[.$]/g, '\\$&');
    const re = new RegExp(`(?<![\\w.$])${esc}\\??\\.([A-Za-z_$][\\w$]*)\\s*(?:\\?\\.)?\\(`, 'g');
    lines.forEach((line, i) => {
      for (const m of line.matchAll(re)) out.push({ alias, kind, method: m[1], line: i + 1 });
    });
  }
  return out;
}

let methods;
let Profiles;
let PRESET_NAMES;

beforeAll(async () => {
  const { AudioSessionStore } = await import('../src/state/audioSessionStore.js');
  const { UIStore } = await import('../src/state/uiStore.js');
  const own = (C) => new Set(Object.getOwnPropertyNames(C.prototype).filter((k) => k !== 'constructor'));
  methods = { session: own(AudioSessionStore), ui: own(UIStore) };
  ({ Profiles } = await import('../src/ui/tokens/design-tokens.js'));
  const presets = await import('../src/core/PresetCalibration.js');
  PRESET_NAMES = new Set([
    ...Object.keys(presets.CALIBRATED_ENGINEER_PRESETS),
    ...Object.keys(presets.PRESET_REDIRECTS),
  ]);
});

describe('store calls resolve on the real stores', () => {
  test('the scanner flags calls to methods the stores do not have', () => {
    // The three calls premium-workspace.js shipped before this guard.
    const broken = [
      '    sessionStore.setSelection(state.selection);',
      '    sessionStore.setActiveProfile(profile);',
      '    uiStore.setActiveProfile?.(profile);',
      '    // sessionStore.notAMethod(x) in a comment is ignored',
      '    sessionStore.setProfile(profile);',
    ].join('\n');
    const missing = storeCalls(broken, { sessionStore: 'session', uiStore: 'ui' })
      .filter((c) => !methods[c.kind].has(c.method))
      .map((c) => `${c.alias}.${c.method}`);
    expect(missing).toEqual([
      'sessionStore.setSelection',
      'sessionStore.setActiveProfile',
      'uiStore.setActiveProfile',
    ]);
  });

  test.each(Object.keys(CONSUMERS))('%s only calls methods that exist', (rel) => {
    const calls = storeCalls(read(rel), CONSUMERS[rel]);
    expect(calls.length).toBeGreaterThan(0);
    const missing = calls
      .filter((c) => !methods[c.kind].has(c.method))
      .map((c) => `${rel}:${c.line} ${c.alias}.${c.method}`);
    // Optional chaining does not excuse a missing method: it only turns the
    // TypeError into a silent no-op.
    expect(missing).toEqual([]);
  });
});

describe('Engineer profiles apply real presets', () => {
  const src = () => read('public/app/lib/signal-canvas-integration.js');
  const profileMap = () => {
    const literal = src().match(/const presets = (\{[^}]*\});/);
    expect(literal).not.toBeNull();
    return Function(`"use strict"; return (${literal[1]});`)();
  };

  test('every profile button maps to a preset applyPreset() knows', () => {
    const map = profileMap();
    const buttons = [...read('public/app/index.html').matchAll(/data-profile="([a-z]+)"/g)].map((m) => m[1]);
    expect(buttons.sort()).toEqual(Object.values(Profiles).sort());
    for (const profile of Object.values(Profiles)) {
      expect({ profile, preset: map[profile], known: PRESET_NAMES.has(map[profile]) })
        .toEqual({ profile, preset: map[profile], known: true });
    }
  });

  test('the profile map is the one __vipApplyProfile uses', () => {
    expect(src()).toMatch(/window\.__vipApplyProfile = window\.__vipApplyProfile \|\| \(\(profile\) => \{[\s\S]{0,400}const presets = \{/);
  });
});
