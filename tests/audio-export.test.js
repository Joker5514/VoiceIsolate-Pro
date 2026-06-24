'use strict';

let encodeWav;
let interleaveChannels;
let buildExportFilename;

beforeAll(async () => {
  ({ encodeWav, interleaveChannels, buildExportFilename } = await import('../src/core/audio-export.js'));
});

describe('audio-export core helpers', () => {
  test('interleaveChannels preserves mono input', () => {
    const mono = new Float32Array([0.1, -0.2, 0.3]);
    expect(Array.from(interleaveChannels([mono]))).toEqual(Array.from(new Float32Array([0.1, -0.2, 0.3])));
  });

  test('interleaveChannels interleaves stereo samples', () => {
    const left = new Float32Array([1, 2]);
    const right = new Float32Array([3, 4]);
    expect(Array.from(interleaveChannels([left, right]))).toEqual([1, 3, 2, 4]);
  });

  test('encodeWav writes a stereo PCM header', () => {
    const wav = encodeWav([new Float32Array([0, 0]), new Float32Array([0, 0])], 48000);
    const view = new DataView(wav);
    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF');
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(34, true)).toBe(16);
  });

  test('buildExportFilename strips unsafe characters and extension', () => {
    expect(buildExportFilename('My Clip?.mp4', 'voice')).toBe('My-Clip-voice.wav');
  });
});