/**
 * Bootstrap: wires ML Worker <-> VAD AudioWorklet via direct MessageChannel.
 * Listens for both 'ready' and 'error' from the worker before proceeding.
 * Times out after 30s so the caller receives a rejection instead of hanging.
 */
export async function bootstrapVAD(
  audioContext: AudioContext
): Promise<{ vadNode: AudioWorkletNode; mlWorker: Worker }> {

  // 1. Spin up the ML worker
  const mlWorker = new Worker(
    new URL('./workers/ml-worker.ts', import.meta.url),
    { type: 'module' }
  );

  // 2. Load the VAD AudioWorklet module
  await audioContext.audioWorklet.addModule(
    new URL('./audio/worklets/vad-processor.ts', import.meta.url)
  );

  // 3. Wait for worker to signal ready (or error) with a 30s timeout
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(
        '[bootstrap-vad] ML worker timed out after 30s. ' +
        'Check model paths: /models/demucs_v4_quant.onnx, ' +
        '/models/ecapa_tdnn.onnx, /models/silero_vad.onnx'
      ));
    }, 30_000);

    mlWorker.addEventListener('message', function handler(e) {
      if (e.data.type === 'ready') {
        clearTimeout(timeout);
        mlWorker.removeEventListener('message', handler);
        resolve();
      } else if (e.data.type === 'error') {
        clearTimeout(timeout);
        mlWorker.removeEventListener('message', handler);
        reject(new Error(`[bootstrap-vad] Worker init failed: ${e.data.message}`));
      }
    });

    // Trigger init after listener is registered
    mlWorker.postMessage({ type: 'init' });
  });

  // 4. Create the VAD AudioWorkletNode
  const vadNode = new AudioWorkletNode(audioContext, 'vad-processor', {
    processorOptions: { sampleRate: audioContext.sampleRate }
  });

  // 5. Create direct MessageChannel bridge: Worklet <-> Worker (no main-thread hop)
  const channel = new MessageChannel();
  mlWorker.postMessage({ type: 'connect_vad', port: channel.port2 }, [channel.port2]);
  vadNode.port.postMessage({ type: 'init_port', port: channel.port1 }, [channel.port1]);

  return { vadNode, mlWorker };
}
