'use strict';
/**
 * Tests for health-monitor.js
 */

const path = require('path');
const { HealthMonitor, healthMonitor } = require(path.join(__dirname, '..', 'public/app/health-monitor.js'));

describe('HealthMonitor — construction', () => {
  test('HealthMonitor is a constructor', () => {
    const hm = new HealthMonitor();
    expect(hm).toBeInstanceOf(HealthMonitor);
  });

  test('isActive is false by default', () => {
    const hm = new HealthMonitor();
    expect(hm.isActive).toBe(false);
  });
});

describe('HealthMonitor — recording samples', () => {
  let hm;
  beforeEach(() => { hm = new HealthMonitor(); });

  test('recordAudioLatency adds samples to snapshot', () => {
    hm.recordAudioLatency(10);
    hm.recordAudioLatency(20);
    const s = hm.snapshot();
    expect(s.audioLatency.samples).toBe(2);
  });

  test('recordInferenceLatency adds samples to snapshot', () => {
    hm.recordInferenceLatency(50);
    const s = hm.snapshot();
    expect(s.inferenceLatency.samples).toBe(1);
  });

  test('recordWorkerLatency adds samples to snapshot', () => {
    hm.recordWorkerLatency(5);
    const s = hm.snapshot();
    expect(s.workerLatency.samples).toBe(1);
  });

  test('rolling buffer caps at 200 samples', () => {
    for (let i = 0; i < 250; i++) hm.recordAudioLatency(i);
    expect(hm.snapshot().audioLatency.samples).toBe(200);
  });
});

describe('HealthMonitor — counters', () => {
  let hm;
  beforeEach(() => { hm = new HealthMonitor(); });

  test('incrementDroppedFrames increments by 1 by default', () => {
    hm.incrementDroppedFrames();
    hm.incrementDroppedFrames();
    expect(hm.snapshot().droppedFrames).toBe(2);
  });

  test('incrementDroppedFrames increments by n', () => {
    hm.incrementDroppedFrames(5);
    expect(hm.snapshot().droppedFrames).toBe(5);
  });

  test('incrementOverflows', () => {
    hm.incrementOverflows(3);
    expect(hm.snapshot().overflows).toBe(3);
  });

  test('incrementErrors', () => {
    hm.incrementErrors();
    hm.incrementErrors(2);
    expect(hm.snapshot().processingErrors).toBe(3);
  });

  test('setWorkerQueueDepth', () => {
    hm.setWorkerQueueDepth(7);
    expect(hm.snapshot().workerQueueDepth).toBe(7);
  });
});

describe('HealthMonitor — snapshot', () => {
  let hm;
  beforeEach(() => { hm = new HealthMonitor(); });

  test('snapshot has expected shape with no data', () => {
    const s = hm.snapshot();
    expect(s).toHaveProperty('timestamp');
    expect(s).toHaveProperty('audioLatency');
    expect(s).toHaveProperty('inferenceLatency');
    expect(s).toHaveProperty('workerLatency');
    expect(s).toHaveProperty('droppedFrames', 0);
    expect(s).toHaveProperty('overflows', 0);
    expect(s).toHaveProperty('processingErrors', 0);
    expect(s).toHaveProperty('workerQueueDepth', 0);
  });

  test('audioLatency avg is correct', () => {
    hm.recordAudioLatency(10);
    hm.recordAudioLatency(20);
    hm.recordAudioLatency(30);
    const s = hm.snapshot();
    expect(s.audioLatency.avg).toBe('20.00 ms');
    expect(s.audioLatency.max).toBe('30.00 ms');
    expect(s.audioLatency.min).toBe('10.00 ms');
  });

  test('zero samples yield "0.00 ms"', () => {
    const s = hm.snapshot();
    expect(s.audioLatency.avg).toBe('0.00 ms');
    expect(s.audioLatency.max).toBe('0.00 ms');
  });

  test('timestamp is a valid ISO string', () => {
    const s = hm.snapshot();
    expect(() => new Date(s.timestamp)).not.toThrow();
    expect(new Date(s.timestamp).toISOString()).toBe(s.timestamp);
  });
});

describe('HealthMonitor — reset', () => {
  test('reset clears all metrics', () => {
    const hm = new HealthMonitor();
    hm.recordAudioLatency(100);
    hm.incrementDroppedFrames(5);
    hm.incrementErrors(3);
    hm.reset();
    const s = hm.snapshot();
    expect(s.audioLatency.samples).toBe(0);
    expect(s.droppedFrames).toBe(0);
    expect(s.processingErrors).toBe(0);
  });
});

describe('HealthMonitor — start / stop', () => {
  test('start sets isActive to true', () => {
    const hm = new HealthMonitor();
    hm.start(60000);
    expect(hm.isActive).toBe(true);
    hm.stop();
  });

  test('stop sets isActive to false', () => {
    const hm = new HealthMonitor();
    hm.start(60000);
    hm.stop();
    expect(hm.isActive).toBe(false);
  });

  test('calling stop when not started does not throw', () => {
    const hm = new HealthMonitor();
    expect(() => hm.stop()).not.toThrow();
  });

  test('start clears previous interval when called twice', () => {
    const hm = new HealthMonitor();
    hm.start(60000);
    hm.start(60000); // should clear first interval
    expect(hm.isActive).toBe(true);
    hm.stop();
  });

  afterEach(() => jest.useRealTimers());
});

describe('HealthMonitor — report', () => {
  test('report returns a snapshot object', () => {
    const hm = new HealthMonitor();
    jest.spyOn(console, 'group').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'groupEnd').mockImplementation(() => {});
    const result = hm.report();
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('droppedFrames');
    jest.restoreAllMocks();
  });
});

describe('healthMonitor singleton', () => {
  test('healthMonitor is a HealthMonitor instance', () => {
    expect(healthMonitor).toBeInstanceOf(HealthMonitor);
  });
});
