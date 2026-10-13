/**
 * Playback worklet loading hardening (gate + de-esser).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const mixer = fs.readFileSync(path.join(ROOT, 'src/pipeline/PlaybackMixer.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const landing = fs.readFileSync(path.join(ROOT, 'public/landing.js'), 'utf8');
const gate = fs.readFileSync(path.join(ROOT, 'src/workers/GateProcessor.js'), 'utf8');
const deess = fs.readFileSync(path.join(ROOT, 'src/workers/DeEsserProcessor.js'), 'utf8');

describe('Worklet module registration', () => {
  test('gate registers vip-gate', () => {
    expect(gate).toContain("registerProcessor('vip-gate'");
  });

  test('de-esser registers vip-deesser', () => {
    expect(deess).toContain("registerProcessor('vip-deesser'");
  });
});

describe('PlaybackMixer load path', () => {
  test('exports ensureWorkletModule and resolveWorkletUrl', () => {
    expect(mixer).toContain('export async function ensureWorkletModule');
    expect(mixer).toContain('export function resolveWorkletUrl');
  });

  test('resumes suspended AudioContext before/around addModule', () => {
    expect(mixer).toMatch(/state === 'suspended'[\s\S]*resume/);
  });

  test('literal addModule paths remain for allowlist', () => {
    expect(mixer).toContain("addModule('/src/workers/GateProcessor.js')");
    expect(mixer).toContain("addModule('/src/workers/DeEsserProcessor.js')");
  });

  test('a failed worklet load reconnects each bypass leg after the failure', async () => {
    const { PlaybackMixer } = await import('../src/pipeline/PlaybackMixer.js');
    const param = () => ({ value: 0, setTargetAtTime: jest.fn(), cancelScheduledValues: jest.fn() });
    const node = (extra = {}) => ({ connect: jest.fn(), disconnect: jest.fn(), ...extra });
    let fail;
    const loads = new Promise((_, reject) => { fail = reject; });
    loads.catch(() => {});
    const ctx = {
      sampleRate: 48000, currentTime: 0, state: 'running', destination: node(),
      createGain: () => node({ gain: param() }),
      createBiquadFilter: () => node({ type: '', frequency: param(), gain: param(), Q: param() }),
      createAnalyser: () => node({ fftSize: 0 }),
      createChannelSplitter: () => node(),
      createChannelMerger: () => node(),
      createDynamicsCompressor: () => node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), reduction: 0 }),
      createDelay: () => node({ delayTime: param() }),
      createWaveShaper: () => node({ curve: null }),
      createBufferSource: () => node({ start: jest.fn(), stop: jest.fn() }),
      resume: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      audioWorklet: { addModule: jest.fn(() => loads) },
    };
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    const realNode = globalThis.AudioWorkletNode;
    globalThis.AudioWorkletNode = jest.fn(() => node({ parameters: new Map(), port: { postMessage: jest.fn() } }));
    try {
      const m = new PlaybackMixer({ context: ctx });
      const gateBefore = m.gateInput.connect.mock.calls.length;
      const deEsserBefore = m.deEsserInput.connect.mock.calls.length;
      fail(new Error('network'));
      await m.workletsReady();
      const gateAfter = m.gateInput.connect.mock.calls.slice(gateBefore).map((c) => c[0]);
      const deEsserAfter = m.deEsserInput.connect.mock.calls.slice(deEsserBefore).map((c) => c[0]);
      expect(gateAfter).toContain(m.highpass);
      expect(deEsserAfter).toContain(m.outputTrim);
      expect(m.getWorkletStatus()).toMatchObject({ gate: { state: 'failed' }, deEsser: { state: 'failed' } });
      expect(globalThis.AudioWorkletNode).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      globalThis.AudioWorkletNode = realNode;
    }
  });
});

describe('Server worklet delivery', () => {
  test('serves /src workers with JS content-type', () => {
    expect(server).toContain("Content-Type', 'application/javascript");
    expect(server).toContain("app.use('/src'");
  });
});

describe('Landing worklet boot', () => {
  test('awaits workletsReady after PlaybackMixer create', () => {
    expect(landing).toContain('workletsReady');
    expect(landing).toContain('getWorkletStatus');
  });
});
