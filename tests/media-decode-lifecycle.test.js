/**
 * Browser file read/decode/resample settlement regressions.
 */
'use strict';

let decodeBlobToAudioBuffer;
let resampleToCanonical;

beforeAll(async () => {
  ({ decodeBlobToAudioBuffer } = await import('../src/pipeline/media-decode.js'));
  ({ resampleToCanonical } = await import('../src/pipeline/FileIngestion.js'));
});

describe('media decode lifecycle', () => {
  const originals = new Map();

  function replaceGlobal(name, value) {
    if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  async function flushMicrotasks() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }

  function namedBlob(name = 'test.wav') {
    const blob = new Blob(['RIFF-test-data'], { type: 'audio/wav' });
    Object.defineProperty(blob, 'name', { configurable: true, value: name });
    return blob;
  }

  afterEach(() => {
    jest.useRealTimers();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    originals.clear();
  });

  test('a decodeAudioData hang times out, closes its owned context, and leaves no timer', async () => {
    jest.useFakeTimers();
    const context = {
      state: 'running',
      decodeAudioData: jest.fn(() => new Promise(() => {})),
      close: jest.fn().mockResolvedValue(undefined),
    };
    replaceGlobal('AudioContext', jest.fn(() => context));
    const pending = decodeBlobToAudioBuffer(namedBlob(), {
      decodeTimeoutMs: 100,
      readTimeoutMs: 100,
    });
    await flushMicrotasks();
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'DECODE_TIMEOUT',
    });

    await jest.advanceTimersByTimeAsync(100);

    await rejection;
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a file read hang times out before creating an AudioContext', async () => {
    jest.useFakeTimers();
    const AudioContext = jest.fn();
    replaceGlobal('AudioContext', AudioContext);
    const file = {
      name: 'hung.wav',
      type: 'audio/wav',
      size: 1024,
      arrayBuffer: jest.fn(() => new Promise(() => {})),
    };
    const pending = decodeBlobToAudioBuffer(file, { readTimeoutMs: 50 });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'FILE_READ_TIMEOUT' });

    await jest.advanceTimersByTimeAsync(50);

    await rejection;
    expect(AudioContext).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('abort settles a hung decode immediately and detaches its deadline', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const context = {
      state: 'running',
      decodeAudioData: jest.fn(() => new Promise(() => {})),
      close: jest.fn().mockResolvedValue(undefined),
    };
    replaceGlobal('AudioContext', jest.fn(() => context));
    const pending = decodeBlobToAudioBuffer(namedBlob('cancel.wav'), {
      signal: controller.signal,
      decodeTimeoutMs: 5000,
    });
    await flushMicrotasks();
    expect(context.decodeAudioData).toHaveBeenCalledTimes(1);

    controller.abort('user');

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('callback and Promise decode APIs still settle exactly once', async () => {
    const decoded = { duration: 1, sampleRate: 48000, length: 48000 };
    const context = {
      state: 'running',
      decodeAudioData: jest.fn((buffer, onSuccess) => {
        onSuccess(decoded);
        return Promise.reject(new Error('late duplicate rejection'));
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    replaceGlobal('AudioContext', jest.fn(() => context));

    await expect(decodeBlobToAudioBuffer(namedBlob('callback.wav'), {
      decodeTimeoutMs: 1000,
    })).resolves.toBe(decoded);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('retains a valid compressed buffer for retry when the first decode detaches its input', async () => {
    const decoded = { duration: 1, sampleRate: 48000, length: 48000 };
    const first = {
      state: 'running',
      decodeAudioData: jest.fn((buffer, onSuccess, onError) => {
        structuredClone(buffer, { transfer: [buffer] });
        onError(new Error('first context rejected input'));
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const retry = {
      state: 'running',
      decodeAudioData: jest.fn((buffer, onSuccess) => {
        expect(buffer.byteLength).toBeGreaterThan(0);
        onSuccess(decoded);
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    replaceGlobal('AudioContext', jest.fn()
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => retry));

    await expect(decodeBlobToAudioBuffer(namedBlob('detached.wav'))).resolves.toBe(decoded);
    expect(retry.decodeAudioData).toHaveBeenCalledTimes(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(retry.close).toHaveBeenCalledTimes(1);
  });

  test('a hanging owned-context close cannot strand a successful decode', async () => {
    const decoded = { duration: 1, sampleRate: 48000, length: 48000 };
    const context = {
      state: 'running',
      decodeAudioData: jest.fn((buffer, onSuccess) => onSuccess(decoded)),
      close: jest.fn(() => new Promise(() => {})),
    };
    replaceGlobal('AudioContext', jest.fn(() => context));

    await expect(decodeBlobToAudioBuffer(namedBlob('close-hang.wav'))).resolves.toBe(decoded);
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('a hung OfflineAudioContext render times out and attempts to stop', async () => {
    jest.useFakeTimers();
    let offline = null;
    class OfflineContext {
      constructor() {
        offline = this;
        this.destination = {};
        this.suspend = jest.fn().mockResolvedValue(undefined);
      }
      createBufferSource() {
        return { connect: jest.fn(), start: jest.fn(), buffer: null };
      }
      startRendering() { return new Promise(() => {}); }
    }
    replaceGlobal('OfflineAudioContext', OfflineContext);
    const buffer = { sampleRate: 44100, length: 44100, duration: 1, numberOfChannels: 1 };
    const pending = resampleToCanonical(buffer, { timeoutMs: 100 });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'RESAMPLE_TIMEOUT' });

    await jest.advanceTimersByTimeAsync(100);

    await rejection;
    expect(offline.suspend).toHaveBeenCalledWith(0);
    expect(jest.getTimerCount()).toBe(0);
  });
});
