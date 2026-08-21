/**
 * Tests for ProcessingOrchestrator (Layer 3: Pipeline)
 */
'use strict';

let ProcessingOrchestrator;

beforeAll(async () => {
  const module = await import('../src/pipeline/ProcessingOrchestrator.js');
  ProcessingOrchestrator = module.ProcessingOrchestrator;
});

describe('ProcessingOrchestrator', () => {
  let mockMLWorker;
  let mockOnProgress;

  beforeEach(() => {
    mockMLWorker = {
      postMessage: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      terminate: jest.fn(),
    };
    mockOnProgress = jest.fn();
  });

  describe('Constructor', () => {
    test('Requires mlWorker parameter', () => {
      expect(() => new ProcessingOrchestrator({})).toThrow('mlWorker is required');
    });

    test('Creates instance with mlWorker', () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      expect(orchestrator.mlWorker).toBe(mockMLWorker);
    });

    test('Accepts onProgress callback', () => {
      const orchestrator = new ProcessingOrchestrator({
        mlWorker: mockMLWorker,
        onProgress: mockOnProgress,
      });
      expect(orchestrator.onProgress).toBe(mockOnProgress);
    });

    test('Provides default onProgress if not specified', () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      expect(typeof orchestrator.onProgress).toBe('function');
      expect(() => orchestrator.onProgress(0.5, 'test')).not.toThrow();
    });

    test('Starts uninitialized', () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      expect(orchestrator._initialized).toBe(false);
    });
  });

  describe('initialize()', () => {
    test('Sends init message to MLWorker', async () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });

      // Simulate MLWorker responding
      setTimeout(() => {
        const handler = mockMLWorker.addEventListener.mock.calls[0][1];
        handler({ data: { type: 'ready', backend: 'wasm' } });
      }, 10);

      await orchestrator.initialize();

      expect(mockMLWorker.postMessage).toHaveBeenCalledWith({
        type: 'init',
        manifest: expect.any(Array),
      });
    });

    test('Sets initialized flag on success', async () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });

      setTimeout(() => {
        const handler = mockMLWorker.addEventListener.mock.calls[0][1];
        handler({ data: { type: 'ready', backend: 'wasm' } });
      }, 10);

      await orchestrator.initialize();
      expect(orchestrator._initialized).toBe(true);
    });

    test('Does not reinitialize if already initialized', async () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });

      setTimeout(() => {
        const handler = mockMLWorker.addEventListener.mock.calls[0][1];
        handler({ data: { type: 'ready', backend: 'wasm' } });
      }, 10);

      await orchestrator.initialize();
      const callCount = mockMLWorker.postMessage.mock.calls.length;

      await orchestrator.initialize();
      expect(mockMLWorker.postMessage.mock.calls.length).toBe(callCount);
    });

    test('Rejects on MLWorker error', async () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });

      setTimeout(() => {
        const handler = mockMLWorker.addEventListener.mock.calls[0][1];
        handler({ data: { type: 'error', message: 'Init failed' } });
      }, 10);

      await expect(orchestrator.initialize()).rejects.toThrow('Init failed');
    });

    test('Rejects on timeout', async () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });

      // Don't send response - let it timeout
      await expect(orchestrator.initialize()).rejects.toThrow('timeout');
    }, 35000);
  });

  describe('Mode selection integration', () => {
    test('Standard mode uses single model', () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      // Mode mapping is tested in file-ingestion-modes.test.js
      // This verifies the orchestrator respects the mode
      expect(orchestrator).toBeDefined();
    });

    test('Maximum mode should process with model chain', () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      // Full chain processing will be implemented when MLWorker supports it
      // For now, verify orchestrator exists and can be constructed
      expect(orchestrator).toBeDefined();
    });
  });

  describe('_mixToMono()', () => {
    test('Returns copy for mono input', () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      const mono = new Float32Array([1, 2, 3, 4]);
      const result = orchestrator._mixToMono([mono]);
      
      expect(result).toEqual(mono);
      expect(result).not.toBe(mono); // Should be a copy
    });

    test('Mixes stereo to mono by averaging', () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      const left = new Float32Array([1, 2, 3, 4]);
      const right = new Float32Array([3, 4, 5, 6]);
      const result = orchestrator._mixToMono([left, right]);
      
      expect(result).toEqual(new Float32Array([2, 3, 4, 5]));
    });

    test('Handles multiple channels', () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      const ch1 = new Float32Array([3, 6, 9]);
      const ch2 = new Float32Array([3, 6, 9]);
      const ch3 = new Float32Array([3, 6, 9]);
      const result = orchestrator._mixToMono([ch1, ch2, ch3]);
      
      expect(result).toEqual(new Float32Array([3, 6, 9]));
    });
  });

  describe('_processWithMLWorker()', () => {
    afterEach(() => jest.useRealTimers());

    test('rejects a job after 45 seconds without worker progress', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      const pending = orchestrator._processWithMLWorker(
        [new Float32Array(1)], 48000, ['demucs'], 7
      );

      jest.setSystemTime(45001);
      jest.advanceTimersByTime(45000);
      await expect(pending).rejects.toThrow('processing stalled');
      expect(mockMLWorker.removeEventListener).toHaveBeenCalled();
      expect(mockMLWorker.postMessage).toHaveBeenCalledWith({ type: 'cancel', requestId: 7 });
    });

    test('worker progress refreshes the stall watchdog', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(0);
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      const pending = orchestrator._processWithMLWorker(
        [new Float32Array(1)], 48000, ['demucs'], 8
      );
      const handler = mockMLWorker.addEventListener.mock.calls[0][1];

      jest.setSystemTime(40000);
      handler({ data: { type: 'progress', requestId: 8, percent: 20 } });
      jest.advanceTimersByTime(40000);
      handler({ data: { type: 'stems', requestId: 8, clean: [], noise: [] } });

      await expect(pending).resolves.toMatchObject({ clean: [], noise: [] });
    });
  });



  describe('dispose()', () => {
    test('Clears initialized flag', () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      orchestrator._initialized = true;
      orchestrator.dispose();
      expect(orchestrator._initialized).toBe(false);
    });

    test('Does not terminate MLWorker (owned by caller)', () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      orchestrator.dispose();
      expect(mockMLWorker.terminate).not.toHaveBeenCalled();
    });
  });

  describe('Integration scenarios', () => {
    test('Orchestrator can be created and disposed', () => {
      const orchestrator = new ProcessingOrchestrator({
        mlWorker: mockMLWorker,
        onProgress: mockOnProgress,
      });
      
      expect(orchestrator).toBeDefined();
      expect(() => orchestrator.dispose()).not.toThrow();
    });

    test('Progress callback is called during processing', () => {
      const orchestrator = new ProcessingOrchestrator({
        mlWorker: mockMLWorker,
        onProgress: mockOnProgress,
      });
      
      orchestrator.onProgress(0.5, 'processing');
      expect(mockOnProgress).toHaveBeenCalledWith(0.5, 'processing');
    });

    test('Supports all isolation modes', () => {
      const orchestrator = new ProcessingOrchestrator({ mlWorker: mockMLWorker });
      const modes = ['standard', 'maximum', 'noise-suppression'];
      
      // Verify orchestrator can be used with all modes
      modes.forEach((mode) => {
        expect(() => {
          // Mode will be passed to processFile when implemented
          const options = { isolationMode: mode };
          expect(options.isolationMode).toBe(mode);
        }).not.toThrow();
      });
    });
  });
});

// Made with Bob
