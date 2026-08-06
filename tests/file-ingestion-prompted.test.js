'use strict';

let fi;

beforeAll(async () => {
  fi = await import('../src/pipeline/FileIngestion.js');
});

describe('FileIngestion prompted mode', () => {
  test('prompted mode is valid and maps to empty model chain', () => {
    expect(fi.isValidIsolationMode('prompted')).toBe(true);
    expect(fi.getModelIdsForMode('prompted')).toEqual([]);
  });

  test('standard still maps to bsrnn', () => {
    expect(fi.getModelIdsForMode('standard')).toEqual(['bsrnn_vocals']);
  });
});
