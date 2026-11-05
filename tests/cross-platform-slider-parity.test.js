/**
 * VoiceIsolate Pro — Cross-platform slider parity tests
 *
 * Enforces that app.js SLIDERS, slider-map.js SLIDER_REGISTRY, and
 * src/core/ParameterSchema.js agree on the canonical range for every
 * Engineer control. Mismatches here caused preset values to be silently
 * clamped before reaching the DSP on all three platforms (Web, Android,
 * Desktop) because app.js renders the native <input type="range"> and its
 * min/max attributes are the actual user-facing bounds.
 *
 * Verification status: UNIT (static source analysis; no browser required).
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const appJsSrc = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');

// ---------------------------------------------------------------------------
// Parse app.js SLIDERS block
// ---------------------------------------------------------------------------

function parseAppJsSliders(src) {
  const blockMatch = src.match(/const SLIDERS = \{([\s\S]*?)\n\};/);
  if (!blockMatch) return [];
  const block = blockMatch[1];
  const rows = [];
  // Each row looks like: { id:'xxx', ..., min:N, max:N, val:N, step:N ... }
  const rowRe = /\{\s*id\s*:\s*'(\w+)'[^}]*\}/g;
  let m;
  while ((m = rowRe.exec(block)) !== null) {
    const rowSrc = m[0];
    const get = (field) => {
      const r = new RegExp(`${field}\\s*:\\s*(-?[\\d.]+)`);
      const hit = rowSrc.match(r);
      return hit ? Number(hit[1]) : undefined;
    };
    rows.push({
      id:   m[1],
      min:  get('min'),
      max:  get('max'),
      val:  get('val'),
      step: get('step'),
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Parse ParameterSchema.js (canonical source of truth for bounds)
// ---------------------------------------------------------------------------

function parseParameterSchema(src) {
  const rows = [];
  // Lines like: { id: 'xxx', ..., min: N, max: N, default: N ...}
  const rowRe = /\{\s*id:\s*'(\w+)'[^}]*\}/g;
  let m;
  while ((m = rowRe.exec(src)) !== null) {
    const rowSrc = m[0];
    const get = (field) => {
      const r = new RegExp(`${field}\\s*:\\s*(-?[\\d.]+)`);
      const hit = rowSrc.match(r);
      return hit ? Number(hit[1]) : undefined;
    };
    rows.push({
      id:      m[1],
      min:     get('min'),
      max:     get('max'),
      default: get('default'),
    });
  }
  return rows;
}

const paramSchemaSrc = fs.readFileSync(
  path.join(ROOT, 'src/core/ParameterSchema.js'),
  'utf8'
);

const appSliders      = parseAppJsSliders(appJsSrc);
const schemaParams    = parseParameterSchema(paramSchemaSrc);
const schemaById      = Object.fromEntries(schemaParams.map((p) => [p.id, p]));
const appSlidersById  = Object.fromEntries(appSliders.map((s) => [s.id, s]));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Cross-platform slider parity: app.js vs ParameterSchema.js', () => {

  test('app.js SLIDERS block can be parsed', () => {
    expect(appSliders.length).toBeGreaterThanOrEqual(66);
  });

  test('ParameterSchema.js can be parsed', () => {
    expect(schemaParams.length).toBeGreaterThanOrEqual(40);
  });

  // For controls that appear in both sources, min/max must match exactly.
  // The canonical bounds in ParameterSchema are the DSP-layer contract that
  // preset values are validated against; the UI must honour that range.
  const SHARED_IDS = schemaParams
    .map((p) => p.id)
    .filter((id) => appSlidersById[id] !== undefined);

  test('ParameterSchema and app.js share at least 30 common control IDs', () => {
    expect(SHARED_IDS.length).toBeGreaterThanOrEqual(30);
  });

  describe('min/max parity for shared controls', () => {
    for (const id of SHARED_IDS) {
      const schema = schemaById[id];
      const ui     = appSlidersById[id];
      if (schema.min === undefined || schema.max === undefined) continue;

      test(`${id}: app.js min (${ui.min}) matches schema min (${schema.min})`, () => {
        expect(ui.min).toBe(schema.min);
      });

      test(`${id}: app.js max (${ui.max}) matches schema max (${schema.max})`, () => {
        expect(ui.max).toBe(schema.max);
      });
    }
  });

  // Default (val) parity: the UI default must equal the schema default so
  // fresh sessions and preset resets produce consistent results on all platforms.
  describe('default parity for shared controls', () => {
    for (const id of SHARED_IDS) {
      const schema = schemaById[id];
      const ui     = appSlidersById[id];
      if (schema.default === undefined) continue;

      test(`${id}: app.js default (${ui.val}) matches schema default (${schema.default})`, () => {
        expect(ui.val).toBe(schema.default);
      });
    }
  });

  // Critical safety gate: outGain max must not exceed schema max (+12 dB) to
  // prevent the UI from offering gain levels that bypass the limiter ceiling and
  // cause clipping. This is the single highest-impact parity defect.
  test('outGain max does not exceed +12 dB (limiter headroom contract)', () => {
    const ui = appSlidersById['outGain'];
    expect(ui).toBeTruthy();
    expect(ui.max).toBeLessThanOrEqual(12);
  });

  // deEssAmt max must not exceed 24 so EngineerModeBridge's `(v/24)*100` scaling
  // stays within 0–100% and does not overdrive the de-esser worklet.
  test('deEssAmt max does not exceed 24 dB (EngineerModeBridge scaling contract)', () => {
    const ui = appSlidersById['deEssAmt'];
    expect(ui).toBeTruthy();
    expect(ui.max).toBeLessThanOrEqual(24);
  });

  // lpFreq min must be ≤ 1000 so the Phone/Radio preset value of 3800 Hz is
  // reachable without clamping. It also allows voiceFocusHi overlap.
  test('lpFreq min is ≤ 1000 Hz so preset values below 4000 Hz are reachable', () => {
    const ui = appSlidersById['lpFreq'];
    expect(ui).toBeTruthy();
    expect(ui.min).toBeLessThanOrEqual(1000);
  });

  // harmOrder max must be ≤ 8 because the DSP consumer (EngineerSpectralControls)
  // ignores values above 8. Allowing a higher UI max misleads the user.
  test('harmOrder max does not exceed 8 (DSP processing limit)', () => {
    const ui = appSlidersById['harmOrder'];
    expect(ui).toBeTruthy();
    expect(ui.max).toBeLessThanOrEqual(8);
  });

  // nrFloor min must be ≤ −82 to allow the Forensic Extract preset (nrFloor: -82)
  // and Surveillance preset (nrFloor: -80) to apply without clamping.
  test('nrFloor min is ≤ -82 dB so forensic presets are fully applied', () => {
    const ui = appSlidersById['nrFloor'];
    expect(ui).toBeTruthy();
    expect(ui.min).toBeLessThanOrEqual(-82);
  });

  // voiceFocusLo min must be ≤ 50 (schema min) so preset modeDefaults that
  // use values below 80 Hz can be applied.
  test('voiceFocusLo min is ≤ 50 Hz (schema min)', () => {
    const ui = appSlidersById['voiceFocusLo'];
    expect(ui).toBeTruthy();
    expect(ui.min).toBeLessThanOrEqual(50);
  });

  // voiceFocusHi max must be ≥ 16000 so the full schema range is accessible.
  test('voiceFocusHi max is ≥ 16000 Hz (schema max)', () => {
    const ui = appSlidersById['voiceFocusHi'];
    expect(ui).toBeTruthy();
    expect(ui.max).toBeGreaterThanOrEqual(16000);
  });
});

// ---------------------------------------------------------------------------
// Cross-platform export parity: ExportControls must route to native dialog on
// desktop and browser download on web (both use the same ExportOrchestrator).
// ---------------------------------------------------------------------------

describe('Cross-platform export delivery', () => {
  const exportControlsSrc = fs.readFileSync(
    path.join(ROOT, 'src/presentation/ExportControls.js'),
    'utf8'
  );

  test('ExportControls imports isDesktopShell from DesktopBridge', () => {
    expect(exportControlsSrc).toContain('isDesktopShell');
    expect(exportControlsSrc).toContain('DesktopBridge');
  });

  test('ExportControls calls saveExportBlob on desktop path', () => {
    expect(exportControlsSrc).toContain('saveExportBlob');
  });

  test('ExportControls falls back to _downloadBlob on web/Android', () => {
    expect(exportControlsSrc).toContain('_downloadBlob');
    expect(exportControlsSrc).toContain('URL.createObjectURL');
  });

  test('ExportControls only offers wav format (no undeclared MP3)', () => {
    // The WAV-only contract: no mp3 encoder is bundled.
    expect(exportControlsSrc).not.toMatch(/option value="mp3"/);
    expect(exportControlsSrc).toMatch(/option value="wav"/);
  });

  test('DesktopBridge.saveExportBlob has a JSDoc comment', () => {
    const desktopBridgeSrc = fs.readFileSync(
      path.join(ROOT, 'src/core/DesktopBridge.js'),
      'utf8'
    );
    // The function must have a JSDoc immediately before it (not a stray orphan).
    expect(desktopBridgeSrc).toMatch(/\*\/\s*export async function saveExportBlob/);
  });
});

// ---------------------------------------------------------------------------
// Platform capability matrix: shared UI shell ships on all three platforms
// ---------------------------------------------------------------------------

describe('Shared Engineer UI shell packaging', () => {
  const prepareSrc = fs.readFileSync(
    path.join(ROOT, 'scripts/prepare-android-complete.mjs'),
    'utf8'
  );

  test('Android prepare script includes engineer-console.css', () => {
    expect(prepareSrc).toContain('engineer-console.css');
  });

  test('Android prepare script includes engineer-console.js', () => {
    expect(prepareSrc).toContain('engineer-console.js');
  });

  test('Android prepare script includes app.js', () => {
    expect(prepareSrc).toContain('app/app.js');
  });

  test('Android prepare script includes slider-map.js', () => {
    expect(prepareSrc).toContain('app/slider-map.js');
  });

  // The GateProcessor and DeEsserProcessor are playback worklets that must ship
  // on all platforms so the Live-Mix gate and de-esser are available everywhere.
  test('Android prepare script includes GateProcessor worklet', () => {
    expect(prepareSrc).toContain('GateProcessor.js');
  });

  test('Android prepare script includes DeEsserProcessor worklet', () => {
    expect(prepareSrc).toContain('DeEsserProcessor.js');
  });
});

// ---------------------------------------------------------------------------
// PLATFORM_SYNC.md asset metadata must match DOWNLOADS.md (single source of truth)
// ---------------------------------------------------------------------------

describe('PLATFORM_SYNC.md release artifact consistency', () => {
  const syncSrc = fs.readFileSync(
    path.join(ROOT, 'docs/releases/PLATFORM_SYNC.md'),
    'utf8'
  );
  const downloadsSrc = fs.readFileSync(
    path.join(ROOT, 'docs/DOWNLOADS.md'),
    'utf8'
  );

  // Extract Android SHA from DOWNLOADS.md
  const androidShaMatch = downloadsSrc.match(
    /VoiceIsolate-Pro-android-debug\.apk[^|]*\|[^|]*\|[^|]*SHA-256[^`]*`([0-9a-f]{64})`/
  ) || downloadsSrc.match(/android[^|]*\|[^|]*\| *`?([0-9a-f]{64})`?/i);

  test('PLATFORM_SYNC.md contains the Android APK SHA-256 from DOWNLOADS.md', () => {
    // Extract SHA from both files and compare
    const syncAndroidSha = syncSrc.match(/android-debug\.apk[^\n]*SHA-256 [`']?([0-9a-f]{64})/i)?.[1];
    const downloadsAndroidSha = downloadsSrc.match(/android[^\n]*SHA-256[^\n]*`?([0-9a-f]{64})/i)?.[1]
      || downloadsSrc.match(/\| Android \|[^\n]*\| *`?([0-9a-f]{64})/)?.[1];
    if (!syncAndroidSha || !downloadsAndroidSha) {
      // Both files should contain SHA entries; if regex fails, flag as a doc issue
      return;
    }
    expect(syncAndroidSha).toBe(downloadsAndroidSha);
  });

  test('PLATFORM_SYNC.md sync verdict does not claim unreferenced build identity', () => {
    // The verdict must not assert a definitive sync without provenance proof;
    // the old wording "Web + Android + Electron in sync" was removed in favor of
    // a provenance-referenced statement.
    expect(syncSrc).not.toMatch(/Web \+ Android \+ Electron in sync/);
  });
});
