'use strict';

/**
 * Magic-byte sniff + generic MIME acceptance for Windows uploads.
 */
const { pathToFileURL } = require('url');
const path = require('path');

let mediaTypes;

beforeAll(async () => {
  mediaTypes = await import(
    pathToFileURL(path.join(__dirname, '../src/core/media-types.js')).href
  );
});

function wavBytes(seconds = 0.05) {
  const sr = 48000;
  const n = Math.floor(sr * seconds);
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

describe('file input accept helpers', () => {
  test('FILE_INPUT_ACCEPT_ANDROID_NATIVE is compact and includes wildcards', () => {
    const a = mediaTypes.FILE_INPUT_ACCEPT_ANDROID_NATIVE;
    expect(a).toMatch(/audio\/\*/);
    expect(a).toMatch(/video\/\*/);
    expect(a).toBe('audio/*,video/*');
    expect(a.split(',').length).toBeLessThan(30);
    expect(mediaTypes.FILE_INPUT_ACCEPT.split(',').length).toBeGreaterThan(a.split(',').length);
  });

  test('getFileInputAccept(forceAndroidNative) returns compact list', () => {
    expect(mediaTypes.getFileInputAccept({ forceAndroidNative: true }))
      .toBe(mediaTypes.FILE_INPUT_ACCEPT_ANDROID_NATIVE);
  });

  test('getFileInputAccept() defaults to full list outside Android native', () => {
    expect(mediaTypes.getFileInputAccept()).toBe(mediaTypes.FILE_INPUT_ACCEPT);
  });
});

describe('media-types sniff + generic MIME', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('isGenericMimeType covers Windows octet-stream', () => {
    expect(mediaTypes.isGenericMimeType('')).toBe(true);
    expect(mediaTypes.isGenericMimeType('application/octet-stream')).toBe(true);
    expect(mediaTypes.isGenericMimeType('binary/octet-stream')).toBe(true);
    expect(mediaTypes.isGenericMimeType('audio/mpeg')).toBe(false);
  });

  test('inferMediaKind rejects bare octet-stream without extension', () => {
    const file = new File([wavBytes()], 'mystery', { type: 'application/octet-stream' });
    expect(mediaTypes.inferMediaKind(file)).toBe(null);
  });

  test('sniffMediaKind detects RIFF/WAVE without extension', async () => {
    const file = new File([wavBytes()], 'mystery', { type: 'application/octet-stream' });
    await expect(mediaTypes.sniffMediaKind(file)).resolves.toBe('audio');
  });

  test('resolveMediaKind recovers WAV from octet-stream', async () => {
    const file = new File([wavBytes()], 'mystery', { type: 'application/octet-stream' });
    await expect(mediaTypes.resolveMediaKind(file)).resolves.toBe('audio');
  });

  test('sniffMediaKind detects ID3/MP3 header', async () => {
    const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const file = new File([id3], 'clip', { type: 'application/octet-stream' });
    await expect(mediaTypes.sniffMediaKind(file)).resolves.toBe('audio');
  });

  test('sniffMediaKind detects ftyp M4A', async () => {
    const head = Buffer.alloc(16);
    head.writeUInt32BE(0, 0);
    head.write('ftyp', 4);
    head.write('M4A ', 8);
    const file = new File([head], 'voice', { type: 'application/octet-stream' });
    await expect(mediaTypes.sniffMediaKind(file)).resolves.toBe('audio');
  });

  test('sniffMediaKind aborts a hung Blob head read', async () => {
    const controller = new AbortController();
    const blob = {
      slice: jest.fn(() => ({ arrayBuffer: () => new Promise(() => {}) })),
    };
    const pending = mediaTypes.sniffMediaKind(blob, {
      signal: controller.signal,
      timeoutMs: 1000,
    });

    controller.abort('user');

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('sniffMediaKind times out a hung Blob head read', async () => {
    jest.useFakeTimers();
    const blob = {
      slice: jest.fn(() => ({ arrayBuffer: () => new Promise(() => {}) })),
    };
    const pending = mediaTypes.sniffMediaKind(blob, { timeoutMs: 25 });
    const rejection = expect(pending).rejects.toMatchObject({
      name: 'TimeoutError',
      code: 'MEDIA_SNIFF_TIMEOUT',
    });

    await jest.advanceTimersByTimeAsync(25);

    await rejection;
    expect(jest.getTimerCount()).toBe(0);
  });
});
