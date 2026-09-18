/**
 * VoiceIsolate Pro — AudioSessionStore contract tests
 *
 * Pins the two defects found validating PR #821:
 *  1. Global subscribers are invoked as listener(event, payload, state) —
 *     a one-parameter subscriber binds `state` to the event-name string and
 *     every read is undefined (broke metrics, overlays and the compare
 *     toggle on the Engineer surface).
 *  2. setAnalysisResult() puts regions at the TOP level of the session
 *     (state.regions) — the canonical shape read by SignalCanvas,
 *     AnalysisOverlay and the overlay list. They must not be duplicated
 *     under state.analysis.regions.
 */
'use strict';

let AudioSessionStore;
let SessionEvents;
let Profiles;
let ComparisonModes;

beforeAll(async () => {
  const storeMod = await import('../src/state/audioSessionStore.js');
  AudioSessionStore = storeMod.AudioSessionStore;
  SessionEvents = storeMod.SessionEvents;
  const tokens = await import('../src/ui/tokens/design-tokens.js');
  Profiles = tokens.Profiles;
  ComparisonModes = tokens.ComparisonModes;
});

describe('subscriber signatures', () => {
  test('global subscribers receive (event, payload, state) with the real session as third arg', () => {
    const store = new AudioSessionStore();
    const calls = [];
    store.subscribe((event, payload, state) => {
      calls.push({ event, payload, state });
    });

    store.setComparisonMode(ComparisonModes.RAW);

    expect(calls.length).toBe(1);
    const { event, payload, state } = calls[0];
    expect(event).toBe(SessionEvents.COMPARE_MODE_CHANGED);
    expect(payload).toBe(ComparisonModes.RAW);
    // The third argument must be the session object itself — NOT the event
    // name string a one-parameter listener would receive.
    expect(typeof state).toBe('object');
    expect(state).not.toBeNull();
    expect(state).toBe(store.getState());
    expect(state.comparisonMode).toBe(ComparisonModes.RAW);
  });

  test('a one-parameter global subscriber sees the event string, proving the old call sites were broken', () => {
    const store = new AudioSessionStore();
    let firstArg = null;
    // Deliberately wrong shape — documents why premium-workspace.js must
    // declare all three parameters.
    store.subscribe((state) => {
      firstArg = state;
    });
    store.setProfile(Profiles.QUICK);
    expect(typeof firstArg).toBe('string'); // the event name, not the session
    expect(firstArg).toBe(SessionEvents.PROFILE_CHANGED);
  });

  test('event-specific subscribers receive (payload, state)', () => {
    const store = new AudioSessionStore();
    const seen = [];
    store.subscribe(SessionEvents.COMPARE_MODE_CHANGED, (payload, state) => {
      seen.push({ payload, state });
    });

    store.setComparisonMode(ComparisonModes.REMOVED);
    // An unrelated event must not reach the specific subscriber.
    store.setProfile(Profiles.MEETING);

    expect(seen.length).toBe(1);
    expect(seen[0].payload).toBe(ComparisonModes.REMOVED);
    // The listener received the session snapshot current at emit time — an
    // object, not an event string. Later updates replace the session object
    // (immutable updates), so compare contents, not identity.
    expect(typeof seen[0].state).toBe('object');
    expect(seen[0].state.comparisonMode).toBe(ComparisonModes.REMOVED);
    expect(seen[0].state.activeProfile).toBe(Profiles.STUDIO); // pre-update profile
    expect(store.getState().activeProfile).toBe(Profiles.MEETING);
    expect(seen[0].state).not.toBe(store.getState());
  });

  test('unsubscribe removes global and event-specific listeners', () => {
    const store = new AudioSessionStore();
    let global = 0;
    let specific = 0;
    const offGlobal = store.subscribe(() => { global += 1; });
    const offSpecific = store.subscribe(SessionEvents.PROFILE_CHANGED, () => { specific += 1; });

    // Default profile is STUDIO — pick different ones so both emit.
    store.setProfile(Profiles.QUICK);
    expect(global).toBe(1);
    expect(specific).toBe(1);

    offGlobal();
    offSpecific();
    store.setProfile(Profiles.FORENSIC);
    expect(global).toBe(1);
    expect(specific).toBe(1);
  });
});

describe('setAnalysisResult regions contract', () => {
  const regions = [
    { id: 'r-1', type: 'speech', start: 0.1, end: 0.4, confidence: 0.9, label: 'Speech' },
  ];

  test('regions land at the top level of the session, not under analysis', () => {
    const store = new AudioSessionStore();
    store.setAnalysisResult({ snrDb: 12.5, speechRatio: 0.4, regions });

    const state = store.getState();
    // Canonical contract: top-level state.regions.
    expect(state.regions).toEqual(regions);
    expect(store.getRegions()).toEqual(regions);
    // Must NOT also exist under analysis — two shapes is exactly the defect.
    expect(state.analysis.regions).toBeUndefined();
    // Other analysis fields still merge into analysis.
    expect(state.analysis.state).toBe('ready');
    expect(state.analysis.progress).toBe(100);
    expect(state.analysis.snrDb).toBe(12.5);
    expect(state.metrics.snrDb).toBe(12.5);
  });

  test('a result without regions keeps previously detected regions', () => {
    const store = new AudioSessionStore();
    store.setAnalysisResult({ regions });
    store.setAnalysisResult({ state: 'error', error: 'boom' });

    const state = store.getState();
    expect(state.regions).toEqual(regions);
    expect(state.analysis.state).toBe('error');
    expect(state.analysis.error).toBe('boom');
  });

  test('setAnalysisResult emits REGIONS_UPDATED with the result payload', () => {
    const store = new AudioSessionStore();
    const events = [];
    store.subscribe((event, payload) => events.push({ event, payload }));
    const result = { regions, snrDb: 6 };
    store.setAnalysisResult(result);
    const match = events.find((e) => e.event === SessionEvents.REGIONS_UPDATED);
    expect(match).toBeDefined();
    expect(match.payload).toBe(result);
  });

  test('re-setting the same comparison mode or profile does not re-emit', () => {
    // Regression: store ↔ ComparisonToggle synced through COMPARE_MODE_CHANGED;
    // emitting for an unchanged mode recursed until the stack overflowed.
    const store = new AudioSessionStore();
    let compareEmits = 0;
    let profileEmits = 0;
    store.subscribe((event) => {
      if (event === SessionEvents.COMPARE_MODE_CHANGED) compareEmits += 1;
      if (event === SessionEvents.PROFILE_CHANGED) profileEmits += 1;
    });

    store.setComparisonMode(ComparisonModes.RAW);
    store.setComparisonMode(ComparisonModes.RAW); // no-op
    store.setComparisonMode(ComparisonModes.RAW); // no-op
    expect(compareEmits).toBe(1);

    store.setProfile(Profiles.FORENSIC);
    store.setProfile(Profiles.FORENSIC); // no-op
    expect(profileEmits).toBe(1);
  });
});
