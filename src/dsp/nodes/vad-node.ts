import { PCMBuffer, DSPNode } from '../types';

export class VADNode implements DSPNode {
  public name = 'VoiceActivityGate';
  public bypass = false;

  private workerPort: MessagePort;
  private isVoiceActive = false;
  private currentGain = 0;
  // Store state as ArrayBuffer to own the memory — slice(0) on receipt breaks transfer chain
  private vadStateBuffer: ArrayBuffer | null = null;

  private readonly attackStep: number;
  private readonly releaseStep: number;
  private readonly sampleRate: number;
  private readonly threshold = 0.5;

  constructor(worker: Worker, sampleRate: number) {
    const channel = new MessageChannel();
    worker.postMessage({ type: 'connect_vad', port: channel.port2 }, [channel.port2]);
    this.workerPort = channel.port1;

    this.sampleRate = sampleRate;
    this.attackStep = 1 / (0.002 * sampleRate);   // 2ms
    this.releaseStep = 1 / (0.200 * sampleRate);  // 200ms

    this.workerPort.onmessage = (e) => {
      const { result } = e.data;
      if (!result) return;
      this.isVoiceActive = result.probability > this.threshold;
      // Clone immediately on receipt — the incoming buffer may be a transferred
      // ArrayBuffer that the worker no longer owns; slice(0) creates an independent copy
      if (result.nextState) {
        const raw = result.nextState instanceof Float32Array
          ? result.nextState.buffer
          : result.nextState;
        this.vadStateBuffer = (raw as ArrayBuffer).slice(0);
      }
    };
  }

  public process(input: Float32Array): Float32Array {
    if (this.bypass) return input;

    // Build state Float32Array from our owned ArrayBuffer — send a fresh slice each frame
    const stateToSend = this.vadStateBuffer
      ? new Float32Array(this.vadStateBuffer.slice(0))
      : undefined;

    // Clone the input PCM before transfer so we don't detach the caller's buffer
    const frameToProcess = new Float32Array(input);

    const msg: any = {
      taskId: `vad_${Date.now()}`,
      payload: {
        task: 'vad',
        pcm: frameToProcess,
        sr: this.sampleRate,
      }
    };
    if (stateToSend) msg.payload.state = stateToSend;

    const transferables: Transferable[] = [frameToProcess.buffer];
    if (stateToSend) transferables.push(stateToSend.buffer);

    this.workerPort.postMessage(msg, transferables);

    // Apply smoothed gate to current frame using the last known voice state
    const output = new Float32Array(input.length);
    const targetGain = this.isVoiceActive ? 1 : 0;

    for (let i = 0; i < input.length; i++) {
      if (this.currentGain < targetGain) {
        this.currentGain = Math.min(targetGain, this.currentGain + this.attackStep);
      } else if (this.currentGain > targetGain) {
        this.currentGain = Math.max(targetGain, this.currentGain - this.releaseStep);
      }
      output[i] = input[i] * this.currentGain;
    }

    return output;
  }
}
