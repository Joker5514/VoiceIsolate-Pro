'use strict';
/**
 * Tests for state-manager.js
 */

const path = require('path');
const { StateManager, appState } = require(path.join(__dirname, '..', 'public/app/state-manager.js'));

// ─── StateManager class ──────────────────────────────────────────────────────

describe('StateManager — get / set', () => {
  let sm;
  beforeEach(() => { sm = new StateManager({ x: 1, y: 'hello', z: false }); });

  test('get returns initial value', () => {
    expect(sm.get('x')).toBe(1);
    expect(sm.get('y')).toBe('hello');
    expect(sm.get('z')).toBe(false);
  });

  test('get returns undefined for unknown key', () => {
    expect(sm.get('unknown')).toBeUndefined();
  });

  test('set updates the value', () => {
    sm.set('x', 42);
    expect(sm.get('x')).toBe(42);
  });

  test('set is a no-op when value is unchanged', () => {
    const fn = jest.fn();
    sm.subscribe('x', fn);
    sm.set('x', 1); // same value
    expect(fn).not.toHaveBeenCalled();
  });

  test('set notifies subscriber with new and previous values', () => {
    const fn = jest.fn();
    sm.subscribe('x', fn);
    sm.set('x', 99);
    expect(fn).toHaveBeenCalledWith(99, 1);
  });

  test('set notifies multiple subscribers for same key', () => {
    const a = jest.fn();
    const b = jest.fn();
    sm.subscribe('x', a);
    sm.subscribe('x', b);
    sm.set('x', 5);
    expect(a).toHaveBeenCalledWith(5, 1);
    expect(b).toHaveBeenCalledWith(5, 1);
  });
});

describe('StateManager — getState', () => {
  test('returns shallow copy of full state', () => {
    const sm = new StateManager({ a: 1, b: 2 });
    const snap = sm.getState();
    expect(snap).toEqual({ a: 1, b: 2 });
    snap.a = 999; // mutating the snapshot should not affect state
    expect(sm.get('a')).toBe(1);
  });
});

describe('StateManager — patch', () => {
  test('updates multiple keys', () => {
    const sm = new StateManager({ a: 1, b: 2, c: 3 });
    sm.patch({ a: 10, b: 20 });
    expect(sm.get('a')).toBe(10);
    expect(sm.get('b')).toBe(20);
    expect(sm.get('c')).toBe(3);
  });

  test('notifies subscribers for each changed key', () => {
    const sm = new StateManager({ a: 1, b: 2 });
    const fa = jest.fn();
    const fb = jest.fn();
    sm.subscribe('a', fa);
    sm.subscribe('b', fb);
    sm.patch({ a: 10, b: 20 });
    expect(fa).toHaveBeenCalledWith(10, 1);
    expect(fb).toHaveBeenCalledWith(20, 2);
  });

  test('does not notify for unchanged keys in patch', () => {
    const sm = new StateManager({ a: 1, b: 2 });
    const fa = jest.fn();
    sm.subscribe('a', fa);
    sm.patch({ a: 1, b: 99 }); // a is unchanged
    expect(fa).not.toHaveBeenCalled();
  });
});

describe('StateManager — subscribe / unsubscribe', () => {
  test('subscribe returns an unsubscribe function', () => {
    const sm = new StateManager({ n: 0 });
    const fn = jest.fn();
    const unsub = sm.subscribe('n', fn);
    sm.set('n', 1);
    expect(fn).toHaveBeenCalledTimes(1);
    unsub();
    sm.set('n', 2);
    expect(fn).toHaveBeenCalledTimes(1); // not called again
  });

  test('unsubscribe removes the specific listener', () => {
    const sm = new StateManager({ n: 0 });
    const a = jest.fn();
    const b = jest.fn();
    sm.subscribe('n', a);
    sm.subscribe('n', b);
    sm.unsubscribe('n', a);
    sm.set('n', 5);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith(5, 0);
  });

  test('unsubscribing a non-existent listener does not throw', () => {
    const sm = new StateManager({});
    expect(() => sm.unsubscribe('key', () => {})).not.toThrow();
  });
});

describe('StateManager — subscribeAll', () => {
  test('subscribeAll receives every key change', () => {
    const sm = new StateManager({ a: 1, b: 2 });
    const fn = jest.fn();
    sm.subscribeAll(fn);
    sm.set('a', 10);
    sm.set('b', 20);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledWith('a', 10, 1);
    expect(fn).toHaveBeenCalledWith('b', 20, 2);
  });

  test('subscribeAll unsubscribe works', () => {
    const sm = new StateManager({ x: 0 });
    const fn = jest.fn();
    const unsub = sm.subscribeAll(fn);
    sm.set('x', 1);
    unsub();
    sm.set('x', 2);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('StateManager — dispatch', () => {
  test('dispatch fires subscribers for the event name', () => {
    const sm = new StateManager({});
    const fn = jest.fn();
    sm.subscribe('processingComplete', fn);
    sm.dispatch('processingComplete', { duration: 1.5 });
    expect(fn).toHaveBeenCalledWith({ duration: 1.5 }, undefined);
  });

  test('dispatch fires subscribeAll listeners', () => {
    const sm = new StateManager({});
    const fn = jest.fn();
    sm.subscribeAll(fn);
    sm.dispatch('myEvent', 'data');
    expect(fn).toHaveBeenCalledWith('myEvent', 'data', undefined);
  });

  test('dispatch does not modify state', () => {
    const sm = new StateManager({ a: 1 });
    sm.dispatch('a', 99);
    expect(sm.get('a')).toBe(1); // dispatch is fire-and-forget, not set
  });
});

describe('StateManager — reset', () => {
  test('reset restores initial values and clears listeners', () => {
    const sm = new StateManager({ x: 5 });
    sm.set('x', 99);
    const fn = jest.fn(); // subscribe AFTER set so fn has no prior call history
    sm.subscribe('x', fn);
    sm.reset();
    expect(sm.get('x')).toBe(5); // restored to initial value
    sm.set('x', 100); // listeners cleared, fn should not be called
    expect(fn).not.toHaveBeenCalled();
  });

  test('reset with no initial values yields empty state', () => {
    const sm = new StateManager();
    sm.reset();
    expect(sm.get('anything')).toBeUndefined();
  });
});

describe('StateManager — listener error isolation', () => {
  test('a throwing listener does not prevent other listeners from being called', () => {
    const sm = new StateManager({ n: 0 });
    const bad  = jest.fn().mockImplementation(() => { throw new Error('boom'); });
    const good = jest.fn();
    sm.subscribe('n', bad);
    sm.subscribe('n', good);
    expect(() => sm.set('n', 1)).not.toThrow();
    expect(good).toHaveBeenCalledWith(1, 0);
  });
});

// ─── appState singleton ──────────────────────────────────────────────────────

describe('appState singleton', () => {
  afterEach(() => {
    // Restore known defaults after each test so they don't bleed
    appState.patch({
      mode: 'idle', isPlaying: false, isProcessing: false,
      mlReady: false, ctxReady: false,
    });
  });

  test('appState is a StateManager instance', () => {
    expect(appState).toBeInstanceOf(StateManager);
  });

  test('mode initial value is "idle"', () => {
    expect(appState.get('mode')).toBe('idle');
  });

  test('isPlaying initial value is false', () => {
    expect(appState.get('isPlaying')).toBe(false);
  });

  test('mlReady initial value is false', () => {
    expect(appState.get('mlReady')).toBe(false);
  });

  test('can set and subscribe to isPlaying', () => {
    const fn = jest.fn();
    const unsub = appState.subscribe('isPlaying', fn);
    appState.set('isPlaying', true);
    expect(fn).toHaveBeenCalledWith(true, false);
    unsub();
  });

  test('getState returns an object with all expected keys', () => {
    const state = appState.getState();
    const expectedKeys = [
      'mode', 'isPlaying', 'isProcessing', 'isRecording',
      'ctxReady', 'workletReady', 'mlReady', 'onnxReady',
      'dspOnlyMode', 'abMode', 'currentFFTSize', 'currentNumBins',
      'sampleRate', 'inputDuration', 'playOffset', 'playSpeed',
      'peakDb', 'rmsDb', 'allowedModels', 'allowedStages',
      'hasInputFile', 'hasOutputFile', 'processingProgress',
      'processingStage', 'errorMessage', 'warnMessage',
    ];
    for (const key of expectedKeys) {
      expect(state).toHaveProperty(key);
    }
  });
});
