import { WorkerPool } from '../dsp/worker-pool';

/**
 * AudioBridge: Main-thread coordinator for VoiceIsolate Pro ML pipeline
 * 
 * Architecture:
 * 1. Decode pool (FFmpeg workers) converts any audio/video format to 44.1kHz mono PCM
 * 2. ML pool (ONNX workers) runs Demucs v4, ECAPA-TDNN, and Silero VAD models
 * 3. SharedArrayBuffer enables zero-copy transfer between pools
 * 
 * Usage:
 *   const bridge = new AudioBridge(audioContext);
 *   await bridge.init();
 *   const result = await bridge.processFile(file);
 *   const audioBuffer = bridge.pcmToAudioBuffer(result.pcm, result.sampleRate);
 */
export class AudioBridge {
  private decodePool: WorkerPool;
  private mlPool: WorkerPool;
  private audioContext: AudioContext;
  private isInitialized = false;

  constructor(audioContext: AudioContext) {
    this.audioContext = audioContext;
    this.decodePool = new WorkerPool(
      new URL('../workers/decode-worker.ts', import.meta.url).href
    );
    this.mlPool = new WorkerPool(
      new URL('../workers/ml-worker.ts', import.meta.url).href
    );
  }

  /**
   * Initialize both worker pools
   * - Decode pool: Loads FFmpeg WASM runtime
   * - ML pool: Loads ONNX models with WebGPU/WASM backends
   */
  async init(): Promise<void> {
    if (this.isInitialized) return;

    await Promise.all([
      this.decodePool.broadcast({ type: 'init' }),
      this.mlPool.broadcast({ type: 'init', payload: { modelDir: '/models' } })
    ]);

    this.isInitialized = true;
    console.log('[AudioBridge] Initialized with', navigator.hardwareConcurrency, 'CPU cores');
  }

  /**
   * Decode audio file to raw PCM using FFmpeg worker pool
   */
  async decodeFile(file: File): Promise<{ pcm: Float32Array; sampleRate: number; channels: number }> {
    const fileData = new Uint8Array(await file.arrayBuffer());
    return this.decodePool.dispatch({
      type: 'decode',
      payload: { fileData, fileName: file.name },
      transferables: [fileData.buffer]
    });
  }

  /**
   * Run Demucs v4 source separation on PCM audio
   */
  async separate(pcm: Float32Array): Promise<Float32Array> {
    // For SharedArrayBuffer: omit from transferables to enable zero-copy
    const isShared = pcm.buffer instanceof SharedArrayBuffer;
    return this.mlPool.dispatch({
      type: 'demucs',
      payload: { audio: pcm },
      transferables: isShared ? [] : [pcm.buffer]
    });
  }

  /**
   * Extract speaker embedding using ECAPA-TDNN
   */
  async getEmbedding(pcm: Float32Array): Promise<Float32Array> {
    const isShared = pcm.buffer instanceof SharedArrayBuffer;
    return this.mlPool.dispatch({
      type: 'ecapa',
      payload: { audio: pcm },
      transferables: isShared ? [] : [pcm.buffer]
    });
  }

  /**
   * Run Silero VAD on audio chunk
   * Returns voice probability [0-1] and updated LSTM state for streaming
   */
  async detectVoice(
    pcm: Float32Array,
    stateH?: Float32Array,
    stateC?: Float32Array
  ): Promise<{ probability: Float32Array; h: Float32Array; c: Float32Array }> {
    return this.mlPool.dispatch({
      type: 'vad',
      payload: { audio: pcm, stateH, stateC }
    });
  }

  /**
   * Full pipeline: decode -> separate -> convert to AudioBuffer
   */
  async processFile(file: File): Promise<AudioBuffer> {
    // Step 1: Decode to PCM
    const { pcm, sampleRate } = await this.decodeFile(file);
    console.log(`[AudioBridge] Decoded ${file.name}: ${pcm.length} samples @ ${sampleRate}Hz`);

    // Step 2: Run ML separation
    const separatedPcm = await this.separate(pcm);
    console.log(`[AudioBridge] Separated: ${separatedPcm.length} samples`);

    // Step 3: Convert to AudioBuffer for Web Audio API
    return this.pcmToAudioBuffer(separatedPcm, sampleRate);
  }

  /**
   * Convert Float32Array PCM to AudioBuffer
   * (Workers cannot create AudioBuffer directly as AudioContext is main-thread only)
   */
  pcmToAudioBuffer(pcm: Float32Array, sampleRate: number): AudioBuffer {
    const channels = 1; // Mono
    const buffer = this.audioContext.createBuffer(channels, pcm.length, sampleRate);
    buffer.copyToChannel(pcm, 0);
    return buffer;
  }

  /**
   * Cleanup: terminate all worker threads
   */
  destroy(): void {
    this.decodePool.terminateAll();
    this.mlPool.terminateAll();
    this.isInitialized = false;
  }
}
