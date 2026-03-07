import * as ort from 'onnxruntime-web';

interface MLTask {
  taskId: string;
  payload: {
    task: 'separate' | 'embed' | 'vad';
    pcm: Float32Array;
    sr: number;
    state?: Float32Array;
  };
}

// Unified postMessage target interface — works for both MessagePort and DedicatedWorkerGlobalScope
type PostTarget = { postMessage(msg: unknown, transfer?: Transferable[]): void };

let demucsSession: ort.InferenceSession;
let ecapaSession: ort.InferenceSession;
let vadSession: ort.InferenceSession;

let vadWorkletPort: MessagePort | null = null;

// Use BASE_URL so model paths resolve correctly when deployed to a sub-path
// (e.g. GitHub Pages at /VoiceIsolate-Pro/). Vite replaces import.meta.env.BASE_URL at build time.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const MODELS = {
  DEMUCS: `${BASE}/models/demucs_v4_quant.onnx`,
  ECAPA:  `${BASE}/models/ecapa_tdnn.onnx`,
  VAD:    `${BASE}/models/silero_vad.onnx`,
};

// Silero VAD state size — v4: [2,1,128]=256 floats; v5: [2,1,64]=128 floats
// Validated at runtime via vadSession.inputNames after load
const SILERO_STATE_SIZE = 256;

async function init() {
  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  };

  try {
    [demucsSession, ecapaSession, vadSession] = await Promise.all([
      ort.InferenceSession.create(MODELS.DEMUCS, options),
      ort.InferenceSession.create(MODELS.ECAPA, options),
      ort.InferenceSession.create(MODELS.VAD, options)
    ]);

    // Validate and log output names so mismatches surface immediately
    console.log('[ml-worker] Demucs outputs:', demucsSession.outputNames);
    console.log('[ml-worker] ECAPA outputs:', ecapaSession.outputNames);
    console.log('[ml-worker] VAD inputs:', vadSession.inputNames, '| outputs:', vadSession.outputNames);

    self.postMessage({ type: 'ready' });
  } catch (err) {
    console.error('[ml-worker] Init error:', err);
    // Propagate to main thread so bootstrap does not hang indefinitely
    self.postMessage({ type: 'error', message: (err as Error).message });
  }
}

async function runInference(task: MLTask, targetPort: PostTarget = self as unknown as PostTarget) {
  const { taskId, payload } = task;
  const { task: type, pcm, sr } = payload;

  try {
    let result: any;

    if (type === 'separate') {
      const tensor = new ort.Tensor('float32', pcm, [1, 1, pcm.length]);
      const output = await demucsSession.run({ input: tensor });
      // Resolve output key at runtime — supports 'vocals', 'output', or first key
      const outKey = demucsSession.outputNames.includes('vocals')
        ? 'vocals'
        : demucsSession.outputNames.includes('output')
          ? 'output'
          : demucsSession.outputNames[0];
      result = output[outKey].data;

    } else if (type === 'embed') {
      const tensor = new ort.Tensor('float32', pcm, [1, pcm.length]);
      const output = await ecapaSession.run({ speech: tensor });
      const embKey = ecapaSession.outputNames.includes('embs')
        ? 'embs'
        : ecapaSession.outputNames[0];
      result = Array.from(output[embKey].data as Float32Array);

    } else if (type === 'vad') {
      // Always clone incoming state — never assume buffer ownership
      const incomingState = payload.state
        ? new Float32Array(payload.state)
        : new Float32Array(SILERO_STATE_SIZE).fill(0);

      const inputs = {
        input: new ort.Tensor('float32', pcm, [1, pcm.length]),
        sr: new ort.Tensor('int64', BigInt64Array.from([BigInt(sr)]), []),
        state: new ort.Tensor('float32', incomingState, [2, 1, SILERO_STATE_SIZE / 2])
      };
      const output = await vadSession.run(inputs);

      const outKey = vadSession.outputNames.includes('output')
        ? 'output'
        : vadSession.outputNames[0];
      const stateKey = vadSession.outputNames.includes('stateN')
        ? 'stateN'
        : vadSession.outputNames.find(k => k !== outKey) ?? vadSession.outputNames[1];

      result = {
        probability: (output[outKey].data as Float32Array)[0],
        nextState: output[stateKey].data
      };
    }

    const transferables: Transferable[] = result?.nextState?.buffer
      ? [result.nextState.buffer]
      : [];
    targetPort.postMessage({ taskId, result }, transferables);

  } catch (e) {
    targetPort.postMessage({ taskId, error: (e as Error).message });
  }
}

self.onmessage = (e: MessageEvent) => {
  const { type, port } = e.data;

  if (type === 'init') {
    init();
  } else if (type === 'connect_vad' && port) {
    vadWorkletPort = port;
    port.onmessage = (workletEvent: MessageEvent) => {
      runInference(workletEvent.data, port as unknown as PostTarget);
    };
  } else if (e.data.taskId) {
    runInference(e.data, self as unknown as PostTarget);
  }
};
