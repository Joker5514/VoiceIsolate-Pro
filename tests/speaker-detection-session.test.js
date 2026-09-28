/**
 * SpeakerDetectionSession — per-file speaker labeling state (Layer 3) and
 * its Engineer wiring.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let SpeakerDetectionSession;

beforeAll(async () => {
  ({ SpeakerDetectionSession } = await import('../src/pipeline/SpeakerDetectionSession.js'));
});

const RESULT = {
  segments: [
    { speakerId: 'S1', label: 'Speaker 1', start: 0, end: 2 },
    { speakerId: 'S2', label: 'Speaker 2', start: 2.5, end: 4 },
  ],
  speakers: [
    { speakerId: 'S1', label: 'Speaker 1', talkTime: 2, segmentCount: 1 },
    { speakerId: 'S2', label: 'Speaker 2', talkTime: 1.5, segmentCount: 1 },
  ],
  method: 'kmeans',
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('SpeakerDetectionSession', () => {
  test('run labels speakers and reports running then done', async () => {
    const states = [];
    const detect = jest.fn(async () => RESULT);
    const s = new SpeakerDetectionSession({ detect, onChange: (x) => states.push(x.state) });
    const ch = new Float32Array(48000);
    await expect(s.run(ch, 48000)).resolves.toBe(true);
    expect(detect).toHaveBeenCalledWith([ch], 48000);
    expect(states).toEqual(['running', 'done']);
    expect(s.speakers.map((sp) => sp.label)).toEqual(['Speaker 1', 'Speaker 2']);
    expect(s.segments).toHaveLength(2);
    expect(s.method).toBe('kmeans');
  });

  test('reset during a run discards the stale result', async () => {
    const d = deferred();
    const s = new SpeakerDetectionSession({ detect: () => d.promise });
    const pending = s.run(new Float32Array(10), 48000);
    s.reset();
    d.resolve(RESULT);
    await expect(pending).resolves.toBe(false);
    expect(s.state).toBeNull();
    expect(s.speakers).toEqual([]);
  });

  test('a newer run wins over an older one that resolves later', async () => {
    const first = deferred();
    const second = deferred();
    const queue = [first, second];
    const s = new SpeakerDetectionSession({ detect: () => queue.shift().promise });
    const a = s.run(new Float32Array(10), 48000);
    const b = s.run(new Float32Array(10), 48000);
    second.resolve(RESULT);
    await b;
    first.resolve({ segments: [], speakers: [], method: 'onnx' });
    await expect(a).resolves.toBe(false);
    expect(s.method).toBe('kmeans');
    expect(s.speakers).toHaveLength(2);
  });

  test('a stale failure does not overwrite the current state', async () => {
    const d = deferred();
    const s = new SpeakerDetectionSession({ detect: () => d.promise });
    const pending = s.run(new Float32Array(10), 48000);
    s.reset();
    d.reject(new Error('boom'));
    await expect(pending).resolves.toBe(false);
    expect(s.state).toBeNull();
  });

  test('failures surface as error state', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new SpeakerDetectionSession({ detect: async () => { throw new Error('boom'); } });
    await expect(s.run(new Float32Array(10), 48000)).resolves.toBe(false);
    expect(s.state).toBe('error');
    expect(s.error.message).toBe('boom');
    await s.run(new Float32Array(0), 48000);
    expect(s.error.message).toBe('no clean stem');
    warn.mockRestore();
  });
});

describe('Engineer wiring', () => {
  const root = path.join(__dirname, '..');
  const app = fs.readFileSync(path.join(root, 'public/app/app.js'), 'utf8');
  const ec = fs.readFileSync(path.join(root, 'public/app/engineer-console.js'), 'utf8');

  function methodBody(src, signature) {
    const start = src.indexOf(signature);
    expect(start).toBeGreaterThan(-1);
    const next = src.slice(start + signature.length).search(/\n {2}(?:async )?[A-Za-z_$][\w$]*\([^)]*\) \{\n/);
    return src.slice(start, next === -1 ? undefined : start + signature.length + next);
  }

  test('runPipeline starts detection after vip:processed without awaiting it', () => {
    const body = methodBody(app, 'async runPipeline(');
    const dispatch = body.indexOf("new CustomEvent('vip:processed'");
    const call = body.indexOf('void this._autoDetectSpeakers(fileSeq);');
    expect(dispatch).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(dispatch);
  });

  test('file changes reset the session', () => {
    expect(methodBody(app, 'async handleFile(')).toMatch(/this\._speakerDetection\?\.reset\(\)/);
    expect(methodBody(app, '_clearFile() {')).toMatch(/this\._speakerDetection\?\.reset\(\)/);
  });

  test('app.js only wires the session', () => {
    const body = methodBody(app, 'async _autoDetectSpeakers(fileSeq)');
    expect(body).toMatch(/import\('\/src\/pipeline\/SpeakerDetectionSession\.js'\)/);
    expect(body).toMatch(/_cleanStemChannels\?\.\[0\]/);
  });

  test('Voice Matrix prefers detected speakers and reports failure', () => {
    expect(ec).toMatch(/app\.getDetectedSpeakers\(\)/);
    expect(ec).toMatch(/longestSegment\(diarSegs, sp\.speakerId\)/);
    expect(ec).toMatch(/Speaker detection failed/);
  });
});
