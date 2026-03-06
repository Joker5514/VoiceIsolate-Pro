import * as ort from 'onnxruntime-web';

export type ModelKey = 'demucs' | 'ecapa' | 'bsrnn' | 'hifigan';

interface ModelEntry {
  session: ort.InferenceSession | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

const MODEL_PATHS: Record<ModelKey, string> = {
  demucs: '/models/demucs-v4-int8.onnx',
  ecapa: '/models/ecapa-tdnn-int8.onnx',
  bsrnn: '/models/bsrnn-int8.onnx',
  hifigan: '/models/hifigan-int8.onnx',
};

export class ModelLoader {
  private models: Map<ModelKey, ModelEntry> = new Map();
  private backend: 'webgpu' | 'webgl' | 'wasm' = 'wasm';

  async initialize(): Promise<void> {
    // Detect best available backend
    if ('gpu' in navigator) {
      try {
        const adapter = await (navigator as any).gpu.requestAdapter();
        if (adapter) {
          this.backend = 'webgpu';
          ort.env.wasm.proxy = true;
          ort.env.wasm.numThreads = navigator.hardwareConcurrency ?? 4;
          return;
        }
      } catch {}
    }
    try {
      // Test WebGL
      const canvas = new OffscreenCanvas(1, 1);
      const gl = canvas.getContext('webgl2');
      if (gl) this.backend = 'webgl';
    } catch {}
    // Default: WASM SIMD
    ort.env.wasm.simd = true;
    ort.env.wasm.numThreads = Math.max(2, (navigator.hardwareConcurrency ?? 4) / 2);
  }

  async loadModel(key: ModelKey, onProgress?: (pct: number) => void): Promise<ort.InferenceSession> {
    const existing = this.models.get(key);
    if (existing?.loaded && existing.session) return existing.session;

    this.models.set(key, { session: null, loading: true, loaded: false, error: null });

    try {
      const path = MODEL_PATHS[key];
      // Stream with progress
      const response = await fetch(path);
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress && contentLength > 0) {
          onProgress(Math.round((received / contentLength) * 100));
        }
      }

      const modelData = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) { modelData.set(chunk, offset); offset += chunk.length; }

      const sessionOptions: ort.InferenceSession.SessionOptions = {
        executionProviders: [this.backend, 'wasm'],
        graphOptimizationLevel: 'all',
        enableMemPattern: true,
        enableCpuMemArena: true,
      };

      const session = await ort.InferenceSession.create(modelData, sessionOptions);
      this.models.set(key, { session, loading: false, loaded: true, error: null });
      return session;
    } catch (err) {
      const error = String(err);
      this.models.set(key, { session: null, loading: false, loaded: false, error });
      throw new Error(`Failed to load model ${key}: ${error}`);
    }
  }

  getSession(key: ModelKey): ort.InferenceSession | null {
    return this.models.get(key)?.session ?? null;
  }

  isLoaded(key: ModelKey): boolean {
    return this.models.get(key)?.loaded ?? false;
  }

  async runDemucs(audioFloat32: Float32Array, sampleRate: number): Promise<Float32Array> {
    const session = this.getSession('demucs');
    if (!session) throw new Error('Demucs not loaded');
    const tensor = new ort.Tensor('float32', audioFloat32, [1, 1, audioFloat32.length]);
    const results = await session.run({ mixture: tensor });
    return results['vocals'].data as Float32Array;
  }

  async runECAPA(audioSegment: Float32Array): Promise<Float32Array> {
    const session = this.getSession('ecapa');
    if (!session) throw new Error('ECAPA not loaded');
    const tensor = new ort.Tensor('float32', audioSegment, [1, audioSegment.length]);
    const results = await session.run({ audio_segment: tensor });
    return results['embedding'].data as Float32Array;
  }

  async runBSRNN(spectrogram: Float32Array, shape: [number, number, number]): Promise<Float32Array> {
    const session = this.getSession('bsrnn');
    if (!session) throw new Error('BSRNN not loaded');
    const tensor = new ort.Tensor('float32', spectrogram, shape);
    const results = await session.run({ spectrogram: tensor });
    return results['voice_mask'].data as Float32Array;
  }

  async runHiFiGAN(melSpectrogram: Float32Array, shape: [number, number, number]): Promise<Float32Array> {
    const session = this.getSession('hifigan');
    if (!session) throw new Error('HiFi-GAN not loaded');
    const tensor = new ort.Tensor('float32', melSpectrogram, shape);
    const results = await session.run({ mel_spectrogram: tensor });
    return results['waveform'].data as Float32Array;
  }
}

export const modelLoader = new ModelLoader();