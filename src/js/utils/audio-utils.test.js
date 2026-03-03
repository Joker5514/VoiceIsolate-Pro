import { describe, it, expect } from 'vitest';
import { splitChannels } from './audio-utils.js';

describe('audio-utils: splitChannels', () => {
  it('should split interleaved stereo data into two mono channels', () => {
    const interleaved = new Float32Array([1, 0.5, -1, -0.5, 0, 0.2]);
    const channelCount = 2;
    const result = splitChannels(interleaved, channelCount);

    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(result[1]).toBeInstanceOf(Float32Array);
    expect(result[0]).toEqual(new Float32Array([1, -1, 0]));
    expect(result[1]).toEqual(new Float32Array([0.5, -0.5, 0.2]));
  });

  it('should handle mono data (1 channel)', () => {
    const interleaved = new Float32Array([0.1, 0.2, 0.3]);
    const channelCount = 1;
    const result = splitChannels(interleaved, channelCount);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(new Float32Array([0.1, 0.2, 0.3]));
  });

  it('should split interleaved 3-channel data', () => {
    const interleaved = new Float32Array([1, 2, 3, 4, 5, 6]);
    const channelCount = 3;
    const result = splitChannels(interleaved, channelCount);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(new Float32Array([1, 4]));
    expect(result[1]).toEqual(new Float32Array([2, 5]));
    expect(result[2]).toEqual(new Float32Array([3, 6]));
  });

  it('should return empty arrays for empty input', () => {
    const interleaved = new Float32Array([]);
    const channelCount = 2;
    const result = splitChannels(interleaved, channelCount);

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(0);
    expect(result[1]).toHaveLength(0);
  });

  it('should ignore trailing samples that do not form a complete frame', () => {
    // 5 samples, 2 channels -> 2 full frames, 1 sample ignored
    const interleaved = new Float32Array([1, 0.5, -1, -0.5, 999]);
    const channelCount = 2;
    const result = splitChannels(interleaved, channelCount);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(new Float32Array([1, -1]));
    expect(result[1]).toEqual(new Float32Array([0.5, -0.5]));
  });
});
