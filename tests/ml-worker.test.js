const fs = require('fs');
const path = require('path');

const workerCode = fs.readFileSync(path.join(__dirname, '../public/app/ml-worker.js'), 'utf8');

describe('ml-worker.js', () => {
  let workerGlobal;
  let postedMessages;

  beforeEach(() => {
    postedMessages = [];

    // Mock ort and other globals
    const mockOrt = {
      env: {
        wasm: {},
        logLevel: 'warning'
      },
      InferenceSession: {
        create: jest.fn()
      },
      Tensor: class {
        constructor(type, data, dims) {
          this.type = type;
          this.data = data;
          this.dims = dims;
        }
      }
    };

    workerGlobal = {
      importScripts: jest.fn(),
      self: {
        postMessage: jest.fn((msg) => postedMessages.push(msg)),
        onmessage: null,
        ort: mockOrt  // ort available via self.ort after importScripts
      },
      navigator: {},
      Float32Array: Float32Array,
      Promise: Promise,
      console: console,
    };

    // Evaluate the worker code in the mock global context
    const argNames = Object.keys(workerGlobal);
    const argValues = argNames.map(name => workerGlobal[name]);

    // Create function that executes worker code with injected globals
    const fn = new Function(...argNames, workerCode);
    fn(...argValues);
  });

  it('should handle Silero VAD loading error path', async () => {
    // Mock the InferenceSession.create to throw an error specifically for silero_vad.onnx
    workerGlobal.self.ort.InferenceSession.create.mockImplementation((modelPath) => {
      if (modelPath.includes('silero_vad.onnx')) {
        return Promise.reject(new Error('Simulated VAD load error'));
      }
      return Promise.resolve({}); // Mock success for other models
    });

    // Trigger the init handler
    await workerGlobal.self.onmessage({ data: { type: 'init' } });

    // Verify error logging
    expect(postedMessages).toContainEqual({
      type: 'log',
      level: 'warn',
      msg: 'VAD unavailable: Simulated VAD load error'
    });

    // Verify ready message shows vad: false
    const readyMsg = postedMessages.find(m => m.type === 'ready');
    expect(readyMsg).toBeDefined();
    expect(readyMsg.models.vad).toBe(false);
    expect(readyMsg.models.deepfilter).toBe(true); // Assuming others succeed
    expect(readyMsg.models.demucs).toBe(true); // Assuming others succeed
  });
});
