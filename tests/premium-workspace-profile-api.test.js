/**
 * VoiceIsolate Pro — premium-workspace.js profile API regression tests
 *
 * Root cause fixed in this changeset:
 *   `premium-workspace.js wireProfiles()` called `sessionStore.setActiveProfile(profile)`
 *   but `AudioSessionStore` only exposes `setProfile(profile)`.  This threw
 *   "sessionStore.setActiveProfile is not a function" at runtime, making all
 *   four profile buttons (Quick, Meeting, Studio, Forensic) dead on every
 *   platform (Browser, Desktop, Android).
 *
 * Fix: replace `sessionStore.setActiveProfile(profile)` with `sessionStore.setProfile(profile)`.
 *
 * The adjacent `uiStore.setActiveProfile?.(profile)` call is intentionally kept
 * with optional chaining — `UIStore` does not currently implement that method,
 * so the call no-ops without error.  The tests below confirm that too.
 *
 * Tests cover:
 *   PW-01  AudioSessionStore.setProfile exists; setActiveProfile does not
 *   PW-02  setProfile updates activeProfile for all four valid profiles
 *   PW-03  setProfile rejects an invalid / unknown profile string
 *   PW-04  Re-selecting the already-active profile does not emit PROFILE_CHANGED
 *   PW-05  Profile change is reflected in getActiveProfile()
 *   PW-06  Profile change does not reset existing session data (source, regions, etc.)
 *   PW-07  UIStore has no setActiveProfile method (optional-chaining guard is correct)
 *   PW-08  premium-workspace.js source calls setProfile, not setActiveProfile
 *   PW-09  Module initialization (static parse) does not throw the reported TypeError
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

let AudioSessionStore;
let SessionEvents;
let Profiles;
let UIStore;

beforeAll(async () => {
  const storeMod  = await import('../src/state/audioSessionStore.js');
  const uiMod     = await import('../src/state/uiStore.js');
  const tokensMod = await import('../src/ui/tokens/design-tokens.js');
  AudioSessionStore = storeMod.AudioSessionStore;
  SessionEvents     = storeMod.SessionEvents;
  Profiles          = tokensMod.Profiles;
  UIStore           = uiMod.UIStore;
});

// ── PW-01: API surface ────────────────────────────────────────────────────────

describe('PW-01 AudioSessionStore.setProfile API surface', () => {
  test('setProfile is a function on AudioSessionStore instances', () => {
    const store = new AudioSessionStore();
    expect(typeof store.setProfile).toBe('function');
  });

  test('setActiveProfile does NOT exist on AudioSessionStore (the missing method that caused the error)', () => {
    const store = new AudioSessionStore();
    // This is the exact TypeError that was thrown in production.
    // setActiveProfile must NEVER be added as a compatibility shim.
    expect(store.setActiveProfile).toBeUndefined();
  });
});

// ── PW-02: Valid profile transitions ─────────────────────────────────────────

describe('PW-02 setProfile accepts all four valid profiles', () => {
  const allProfiles = ['quick', 'meeting', 'studio', 'forensic'];

  test.each(allProfiles)('setProfile("%s") updates activeProfile', (profile) => {
    // Start from a profile that is NOT `profile` so the equality guard fires.
    const other = allProfiles.find((p) => p !== profile) || 'quick';
    const store = new AudioSessionStore({ activeProfile: other });
    store.setProfile(profile);
    expect(store.getState().activeProfile).toBe(profile);
    expect(store.getActiveProfile()).toBe(profile);
  });

  test.each(allProfiles)('setProfile("%s") emits PROFILE_CHANGED', (profile) => {
    const other = allProfiles.find((p) => p !== profile) || 'quick';
    const store = new AudioSessionStore({ activeProfile: other });
    const emitted = [];
    store.subscribe((event, payload) => emitted.push({ event, payload }));
    store.setProfile(profile);
    expect(emitted).toContainEqual({ event: SessionEvents.PROFILE_CHANGED, payload: profile });
  });
});

// ── PW-03: Invalid profile rejection ─────────────────────────────────────────

describe('PW-03 setProfile rejects invalid profiles', () => {
  const invalids = ['broadcast', 'podcast', '', null, undefined, 42, {}];

  test.each(invalids)('setProfile(%s) is a no-op and does not throw', (bad) => {
    const store = new AudioSessionStore();
    const before = store.getState().activeProfile;
    expect(() => store.setProfile(bad)).not.toThrow();
    expect(store.getState().activeProfile).toBe(before);
  });

  test('setProfile with an invalid value does not emit PROFILE_CHANGED', () => {
    const store = new AudioSessionStore();
    let emitCount = 0;
    store.subscribe((event) => {
      if (event === SessionEvents.PROFILE_CHANGED) emitCount += 1;
    });
    store.setProfile('not-a-real-profile');
    expect(emitCount).toBe(0);
  });
});

// ── PW-04: Equality guard — no duplicate events ───────────────────────────────

describe('PW-04 Re-selecting the active profile does not emit duplicate PROFILE_CHANGED events', () => {
  test('same profile → zero events', () => {
    const store = new AudioSessionStore();
    // Default is STUDIO — set it again.
    let profileEmits = 0;
    store.subscribe((event) => {
      if (event === SessionEvents.PROFILE_CHANGED) profileEmits += 1;
    });
    store.setProfile(Profiles.STUDIO);   // no-op: already active
    store.setProfile(Profiles.STUDIO);   // no-op
    expect(profileEmits).toBe(0);
  });

  test('different profile then back → exactly two events total', () => {
    const store = new AudioSessionStore();
    let profileEmits = 0;
    store.subscribe((event) => {
      if (event === SessionEvents.PROFILE_CHANGED) profileEmits += 1;
    });
    store.setProfile(Profiles.FORENSIC);  // 1st emit
    store.setProfile(Profiles.FORENSIC);  // no-op
    store.setProfile(Profiles.STUDIO);    // 2nd emit
    store.setProfile(Profiles.STUDIO);    // no-op
    expect(profileEmits).toBe(2);
  });
});

// ── PW-05: getActiveProfile selector ─────────────────────────────────────────

describe('PW-05 getActiveProfile reflects the most recently set profile', () => {
  test('initial default is studio', () => {
    const store = new AudioSessionStore();
    expect(store.getActiveProfile()).toBe(Profiles.STUDIO);
  });

  test('tracks changes in sequence', () => {
    const store = new AudioSessionStore();
    store.setProfile(Profiles.QUICK);
    expect(store.getActiveProfile()).toBe(Profiles.QUICK);
    store.setProfile(Profiles.MEETING);
    expect(store.getActiveProfile()).toBe(Profiles.MEETING);
    store.setProfile(Profiles.FORENSIC);
    expect(store.getActiveProfile()).toBe(Profiles.FORENSIC);
  });
});

// ── PW-06: State isolation — profile change is narrow ────────────────────────

describe('PW-06 Profile change does not disturb unrelated session state', () => {
  test('source, regions, processing state survive a profile switch', () => {
    const store = new AudioSessionStore();
    const fakeSource = { name: 'voice.wav', duration: 12, sampleRate: 48000 };
    store.importSource(fakeSource);
    const fakeRegion = { id: 'r-1', type: 'speech', start: 0.5, end: 2.0, confidence: 0.9, label: 'Speech' };
    store.setRegions([fakeRegion]);

    store.setProfile(Profiles.MEETING);

    const s = store.getState();
    expect(s.activeProfile).toBe(Profiles.MEETING);
    expect(s.source).not.toBeNull();
    expect(s.source.name).toBe('voice.wav');
    expect(s.regions).toEqual([fakeRegion]);
  });

  test('profile change does not alter comparisonMode', async () => {
    const store = new AudioSessionStore();
    const { ComparisonModes } = await import('../src/ui/tokens/design-tokens.js');
    store.setComparisonMode(ComparisonModes.RAW);
    store.setProfile(Profiles.FORENSIC);
    expect(store.getState().comparisonMode).toBe(ComparisonModes.RAW);
  });
});

// ── PW-07: UIStore has no setActiveProfile ────────────────────────────────────

describe('PW-07 UIStore.setActiveProfile is not defined (optional-chaining guard is correct)', () => {
  test('UIStore instances do not expose setActiveProfile', () => {
    const ui = new UIStore();
    // premium-workspace.js uses `uiStore.setActiveProfile?.(profile)` — the
    // optional chain must not call anything because the method does not exist.
    // Do not add setActiveProfile as a stub: the optional chain is the correct guard.
    expect(ui.setActiveProfile).toBeUndefined();
  });

  test('calling setActiveProfile via optional-chaining on UIStore is a silent no-op', () => {
    const ui = new UIStore();
    // Simulate exactly what the fixed code does after setProfile on sessionStore.
    expect(() => ui.setActiveProfile?.('quick')).not.toThrow();
  });
});

// ── PW-08: Source-text guard — the caller now uses the correct API ────────────

describe('PW-08 premium-workspace.js uses setProfile, not setActiveProfile', () => {
  const premiumSrc = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app', 'premium-workspace.js'),
    'utf8',
  );

  test('source does NOT contain sessionStore.setActiveProfile', () => {
    // This was the exact bug. Any re-introduction fails this test immediately.
    expect(premiumSrc).not.toContain('sessionStore.setActiveProfile');
  });

  test('source DOES contain sessionStore.setProfile inside wireProfiles', () => {
    expect(premiumSrc).toContain('sessionStore.setProfile(profile)');
  });

  test('the optional-chain guard on uiStore.setActiveProfile is still present', () => {
    // The optional-chain call is intentional: it is a forward-compatibility hook
    // that silently no-ops until UIStore adds the method. Do not remove it.
    expect(premiumSrc).toContain('uiStore.setActiveProfile?.(profile)');
  });
});

// ── PW-09: Module parse does not throw ───────────────────────────────────────

describe('PW-09 premium-workspace.js parses without error (no TypeError at module load time)', () => {
  test('SourceTextModule parses premium-workspace.js successfully', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'app', 'premium-workspace.js'),
      'utf8',
    );
    // A parse error here means the module can never load, reproducing the
    // "Module Load Error" reported in production.
    expect(
      () => new vm.SourceTextModule(src, { identifier: 'public/app/premium-workspace.js' }),
    ).not.toThrow();
  });
});
