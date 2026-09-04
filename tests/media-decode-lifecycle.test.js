/**
 * Browser file read/decode/resample settlement regressions.
 */
'use strict';

let decodeBlobToAudioBuffer;
let disposeSharedDecodeContexts;
let resampleToCanonical;
let ingestFile;
let getTimings;

beforeAll(async () => {
  ({ decodeBlobToAudioBuffer, disposeSharedDecodeContexts } = await import('../src/pipeline/media-decode.js'));
  ({ resampleToCanonical, ingestFile } = await import('../src/pipeline/FileIngestion.js'));
  ({ getTimings } = await import('../src/pipeline/PipelineTiming.js'));
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
    disposeSharedDecodeContexts();
    jest.useRealTimers();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    originals.clear();
  });

  test('a decodeAudioData hang times out and explicit disposal closes the shared context', async () => {
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
    expect(context.close).not.toHaveBeenCalled();
    disposeSharedDecodeContexts();
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
    expect(context.close).not.toHaveBeenCalled();
    disposeSharedDecodeContexts();
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
    expect(context.close).not.toHaveBeenCalled();
    disposeSharedDecodeContexts();
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
    disposeSharedDecodeContexts();
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
    expect(context.close).not.toHaveBeenCalled();
    disposeSharedDecodeContexts();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('reuses one owned primary context across repeated decodes', async () => {
    const decoded = { duration: 1, sampleRate: 48000, length: 48000 };
    const context = {
      state: 'running',
      decodeAudioData: jest.fn((buffer, onSuccess) => onSuccess(decoded)),
      close: jest.fn(() => new Promise(() => {})),
    };
    const AudioContext = jest.fn(() => context);
    replaceGlobal('AudioContext', AudioContext);

    await decodeBlobToAudioBuffer(namedBlob('one.wav'));
    await decodeBlobToAudioBuffer(namedBlob('two.wav'));

    expect(AudioContext).toHaveBeenCalledTimes(1);
    expect(AudioContext).toHaveBeenCalledWith({ sampleRate: 48000 });
    expect(context.decodeAudioData).toHaveBeenCalledTimes(2);
    disposeSharedDecodeContexts();
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  test('preserves AbortError from the media-element fallback', async () => {
    const controller = new AbortController();
    const media = {
      readyState: 1,
      duration: 1,
      playbackRate: 1,
      defaultPlaybackRate: 1,
      style: {},
      setAttribute: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      removeAttribute: jest.fn(),
      load: jest.fn(),
      remove: jest.fn(),
      pause: jest.fn(),
      play: jest.fn(() => {
        controller.abort('user');
        return new Promise(() => {});
      }),
    };
    const node = { connect: jest.fn(), disconnect: jest.fn(), onaudioprocess: null };
    const primary = {
      state: 'running',
      destination: {},
      decodeAudioData: jest.fn((buffer, onSuccess, onError) => onError(new Error('primary failed'))),
      createMediaElementSource: jest.fn(() => node),
      createScriptProcessor: jest.fn(() => node),
      createGain: jest.fn(() => ({ ...node, gain: { value: 1 } })),
    };
    const retry = {
      state: 'running',
      decodeAudioData: jest.fn((buffer, onSuccess, onError) => onError(new Error('retry failed'))),
      close: jest.fn().mockResolvedValue(undefined),
    };
    replaceGlobal('AudioContext', jest.fn(() => retry));
    replaceGlobal('HTMLMediaElement', { HAVE_METADATA: 1 });
    replaceGlobal('document', {
      body: { appendChild: jest.fn() },
      createElement: jest.fn(() => media),
    });
    replaceGlobal('URL', {
      createObjectURL: jest.fn(() => 'blob:test'),
      revokeObjectURL: jest.fn(),
    });

    await expect(decodeBlobToAudioBuffer(namedBlob('fallback.wav'), {
      audioContext: primary,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a hung OfflineAudioContext render times out and attempts to stop', async () => {
    jest.useFakeTimers();
    let offline = null;
    class OfflineContext {
      constructor() {
        offline = this;
        this.destination = {};
        this.currentTime = 0;
        this.suspend = jest.fn().mockResolvedValue(undefined);
      }
      createBufferSource() {
        this.source = {
          connect: jest.fn(),
          disconnect: jest.fn(),
          start: jest.fn(),
          stop: jest.fn(),
          buffer: null,
        };
        return this.source;
      }
      startRendering() { return new Promise(() => {}); }
    }
    replaceGlobal('OfflineAudioContext', OfflineContext);
    const buffer = { sampleRate: 44100, length: 44100, duration: 1, numberOfChannels: 1 };
    const pending = resampleToCanonical(buffer, { timeoutMs: 100 });
    const rejection = expect(pending).rejects.toMatchObject({ code: 'RESAMPLE_TIMEOUT' });

    await jest.advanceTimersByTimeAsync(100);

    await rejection;
    expect(offline.source.stop).toHaveBeenCalledWith(0);
    expect(offline.source.disconnect).toHaveBeenCalled();
    expect(offline.suspend.mock.calls[0][0]).toBeGreaterThan(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('finalizes decode timing when ingestion fails', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const audioContext = {
      state: 'running',
      decodeAudioData: jest.fn(() => Promise.reject(new Error('invalid audio'))),
    };
    const pending = ingestFile(namedBlob('broken.wav'), { audioContext });
    await expect(pending).rejects.toThrow('Could not decode');
    const finishedAt = getTimings().decode;

    jest.setSystemTime(5000);

    expect(getTimings().decode).toBe(finishedAt);
  });
});
