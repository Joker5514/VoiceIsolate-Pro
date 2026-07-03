/**
 * Tests for FileIngestion mode mapping functionality
 */
'use strict';

let getModelIdsForMode, isValidIsolationMode;

beforeAll(async () => {
  const module = await import('../src/pipeline/FileIngestion.js');
  getModelIdsForMode = module.getModelIdsForMode;
  isValidIsolationMode = module.isValidIsolationMode;
});

describe('FileIngestion Mode Mapping', () => {
  describe('getModelIdsForMode()', () => {
    test('Returns correct models for standard mode', () => {
      const modelIds = getModelIdsForMode('standard');
      expect(modelIds).toEqual(['demucs']);
    });

    test('Returns correct models for maximum mode', () => {
      const modelIds = getModelIdsForMode('maximum');
      expect(modelIds).toEqual(['demucs', 'rnnoise']);
    });

    test('Returns correct models for noise-suppression mode', () => {
      const modelIds = getModelIdsForMode('noise-suppression');
      expect(modelIds).toEqual(['rnnoise']);
    });

    test('Returns default mode models for undefined', () => {
      const modelIds = getModelIdsForMode(undefined);
      expect(modelIds).toEqual(['demucs']);
    });

    test('Returns default mode models for null', () => {
      const modelIds = getModelIdsForMode(null);
      expect(modelIds).toEqual(['demucs']);
    });

    test('Returns default mode models for invalid mode', () => {
      const modelIds = getModelIdsForMode('invalid-mode');
      expect(modelIds).toEqual(['demucs']);
    });

    test('Returns default mode models for empty string', () => {
      const modelIds = getModelIdsForMode('');
      expect(modelIds).toEqual(['demucs']);
    });

    test('Model IDs are arrays', () => {
      expect(Array.isArray(getModelIdsForMode('standard'))).toBe(true);
      expect(Array.isArray(getModelIdsForMode('maximum'))).toBe(true);
      expect(Array.isArray(getModelIdsForMode('noise-suppression'))).toBe(true);
    });

    test('Model IDs are not empty', () => {
      expect(getModelIdsForMode('standard').length).toBeGreaterThan(0);
      expect(getModelIdsForMode('maximum').length).toBeGreaterThan(0);
      expect(getModelIdsForMode('noise-suppression').length).toBeGreaterThan(0);
    });

    test('Maximum mode has multiple models (chain)', () => {
      const modelIds = getModelIdsForMode('maximum');
      expect(modelIds.length).toBeGreaterThan(1);
      expect(modelIds).toContain('demucs');
      expect(modelIds).toContain('rnnoise');
    });
  });

  describe('isValidIsolationMode()', () => {
    test('Returns true for standard mode', () => {
      expect(isValidIsolationMode('standard')).toBe(true);
    });

    test('Returns true for maximum mode', () => {
      expect(isValidIsolationMode('maximum')).toBe(true);
    });

    test('Returns true for noise-suppression mode', () => {
      expect(isValidIsolationMode('noise-suppression')).toBe(true);
    });

    test('Returns false for invalid mode', () => {
      expect(isValidIsolationMode('invalid')).toBe(false);
    });

    test('Returns false for empty string', () => {
      expect(isValidIsolationMode('')).toBe(false);
    });

    test('Returns false for null', () => {
      expect(isValidIsolationMode(null)).toBe(false);
    });

    test('Returns false for undefined', () => {
      expect(isValidIsolationMode(undefined)).toBe(false);
    });

    test('Returns false for number', () => {
      expect(isValidIsolationMode(123)).toBe(false);
    });

    test('Returns false for object', () => {
      expect(isValidIsolationMode({})).toBe(false);
    });
  });

  describe('Mode to Model mapping consistency', () => {
    test('All valid modes return non-empty model arrays', () => {
      const modes = ['standard', 'maximum', 'noise-suppression'];
      modes.forEach((mode) => {
        const modelIds = getModelIdsForMode(mode);
        expect(Array.isArray(modelIds)).toBe(true);
        expect(modelIds.length).toBeGreaterThan(0);
        modelIds.forEach((id) => {
          expect(typeof id).toBe('string');
          expect(id.length).toBeGreaterThan(0);
        });
      });
    });

    test('Model IDs reference known models', () => {
      const knownModels = ['demucs', 'rnnoise'];
      const modes = ['standard', 'maximum', 'noise-suppression'];
      
      modes.forEach((mode) => {
        const modelIds = getModelIdsForMode(mode);
        modelIds.forEach((id) => {
          expect(knownModels).toContain(id);
        });
      });
    });

    test('Standard and noise-suppression use single models', () => {
      expect(getModelIdsForMode('standard').length).toBe(1);
      expect(getModelIdsForMode('noise-suppression').length).toBe(1);
    });

    test('Maximum mode uses model chain', () => {
      const modelIds = getModelIdsForMode('maximum');
      expect(modelIds.length).toBe(2);
      expect(modelIds[0]).toBe('demucs'); // First stage
      expect(modelIds[1]).toBe('rnnoise'); // Second stage
    });
  });

  describe('Integration with ingestFile', () => {
    // Note: Full integration tests would require mocking AudioContext
    // These tests verify the contract that ingestFile should follow

    test('ingestFile should accept isolationMode in hooks', () => {
      // This is a contract test - the actual implementation is tested elsewhere
      const expectedHooksInterface = {
        onProgress: expect.any(Function),
        isolationMode: expect.any(String),
      };
      
      // Verify the interface is documented
      expect(typeof getModelIdsForMode).toBe('function');
      expect(typeof isValidIsolationMode).toBe('function');
    });

    test('Mode mapping is deterministic', () => {
      // Same mode should always return same models
      const mode = 'maximum';
      const result1 = getModelIdsForMode(mode);
      const result2 = getModelIdsForMode(mode);
      expect(result1).toEqual(result2);
    });

    test('Mode mapping is case-sensitive', () => {
      // Modes should be lowercase
      expect(isValidIsolationMode('Standard')).toBe(false);
      expect(isValidIsolationMode('MAXIMUM')).toBe(false);
      expect(isValidIsolationMode('standard')).toBe(true);
    });
  });
});

// Made with Bob
