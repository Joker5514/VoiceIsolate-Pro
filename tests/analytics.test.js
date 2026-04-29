// tests/analytics.test.js — VoiceIsolate Pro
// Vitest test suite for analytics.js
// CRITICAL: Proves zero external network calls are ever made.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  track,
  trackProcessing,
  getEvents,
  clearEvents,
  getSummary,
} from '../public/app/analytics.js';

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// ── Basic functionality ───────────────────────────────────────────────────

describe('track()', () => {
  it('stores an event in localStorage with correct shape', () => {
    track('test-event', { foo: 'bar' });
    const events = getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event:   'test-event',
      payload: { foo: 'bar' },
    });
    expect(typeof events[0].timestamp).toBe('number');
  });

  it('accumulates multiple events in order', () => {
    track('a'); track('b'); track('c');
    expect(getEvents().map(e => e.event)).toEqual(['a', 'b', 'c']);
  });
});

describe('getEvents()', () => {
  it('returns empty array when no events stored', () => {
    expect(getEvents()).toEqual([]);
  });

  it('returns all stored events', () => {
    track('x', { n: 1 }); track('y', { n: 2 });
    expect(getEvents()).toHaveLength(2);
  });
});

describe('clearEvents()', () => {
  it('removes all stored events', () => {
    track('to-be-cleared');
    clearEvents();
    expect(getEvents()).toEqual([]);
  });
});

describe('getSummary()', () => {
  it('returns zeroed summary when no events exist', () => {
    const s = getSummary();
    expect(s.totalEvents).toBe(0);
    expect(s.processingCount).toBe(0);
    expect(s.avgDurationMs).toBe(0);
    expect(s.errorRate).toBe(0);
    expect(s.lastEventTime).toBeNull();
  });

  it('computes correct avgDurationMs', () => {
    trackProcessing({ durationMs: 100, stageName: 'stft', tier: 'PRO',  hadError: false });
    trackProcessing({ durationMs: 200, stageName: 'ml',   tier: 'PRO',  hadError: false });
    expect(getSummary().avgDurationMs).toBe(150);
  });

  it('computes correct errorRate', () => {
    trackProcessing({ durationMs: 50, stageName: 'stft', tier: 'FREE', hadError: false });
    trackProcessing({ durationMs: 50, stageName: 'ml',   tier: 'FREE', hadError: true  });
    expect(getSummary().errorRate).toBeCloseTo(0.5);
  });

  it('sets lastEventTime to the most recent event timestamp', () => {
    track('first');
    const before = Date.now();
    track('last');
    const s = getSummary();
    expect(s.lastEventTime).toBeGreaterThanOrEqual(before);
  });
});

// ── Ring-buffer eviction ──────────────────────────────────────────────────

describe('track() ring-buffer eviction at 500 events', () => {
  it('evicts the oldest event when cap is exceeded', () => {
    for (let i = 0; i < 500; i++) track('fill', { i });
    expect(getEvents()).toHaveLength(500);
    expect(getEvents()[0].payload.i).toBe(0);

    track('overflow', { i: 500 });
    const events = getEvents();
    expect(events).toHaveLength(500);
    expect(events[0].payload.i).toBe(1);       // oldest evicted
    expect(events[499].event).toBe('overflow'); // newest at tail
  });
});

// ── CRITICAL: Zero network call assertions ────────────────────────────────

describe('ZERO_EXTERNAL_CALLS — fetch spy', () => {
  it('track() never calls fetch()', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({});
    track('spy-test', { x: 1 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('trackProcessing() never calls fetch()', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({});
    trackProcessing({ durationMs: 99, stageName: 'gate', tier: 'STUDIO', hadError: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('getEvents() never calls fetch()', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({});
    track('pre-get');
    getEvents();
    expect(spy).not.toHaveBeenCalled();
  });

  it('getSummary() never calls fetch()', () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({});
    getSummary();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('ZERO_EXTERNAL_CALLS — sendBeacon spy', () => {
  it('track() never calls navigator.sendBeacon()', () => {
    const spy = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
    track('beacon-test');
    expect(spy).not.toHaveBeenCalled();
  });

  it('trackProcessing() never calls navigator.sendBeacon()', () => {
    const spy = vi.spyOn(navigator, 'sendBeacon').mockReturnValue(true);
    trackProcessing({ durationMs: 10, stageName: 'iSTFT', tier: 'ENTERPRISE', hadError: false });
    expect(spy).not.toHaveBeenCalled();
  });
});

// ── trackProcessing field validation ─────────────────────────────────────

describe('trackProcessing()', () => {
  it('stores tier and stageName correctly', () => {
    trackProcessing({
      durationMs: 333,
      fileSize:   1024 * 1024,
      stageName:  'demucs-inference',
      tier:       'STUDIO',
      hadError:   false,
    });
    const e = getEvents()[0];
    expect(e.event).toBe('processing');
    expect(e.payload.tier).toBe('STUDIO');
    expect(e.payload.stageName).toBe('demucs-inference');
    expect(e.payload.fileSize).toBe(1024 * 1024);
  });

  it('defaults all missing fields gracefully', () => {
    trackProcessing({});
    const e = getEvents()[0];
    expect(e.payload.durationMs).toBe(0);
    expect(e.payload.tier).toBe('FREE');
    expect(e.payload.stageName).toBe('unknown');
    expect(e.payload.hadError).toBe(false);
  });
});
