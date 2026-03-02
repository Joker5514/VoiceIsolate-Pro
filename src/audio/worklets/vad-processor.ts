const FRAME_SIZE = 512;

class VADProcessor extends AudioWorkletProcessor {
  private workerPort: MessagePort | null = null;

  private frameBuffer: Float32Array;
  private bufferIndex: number = 0;

  private isVoiceActive: boolean = false;
  private currentGain: number = 0;
  // Own the state as ArrayBuffer — slice(0) on receipt, slice(0) on dispatch
  private vadStateBuffer: ArrayBuffer | null = null;

  private readonly attackStep: number;
  private readonly releaseStep: number;
  private readonly threshold: number = 0.5;
  private readonly processorSampleRate: number;

  constructor(options: AudioWorkletNodeOptions) {
    super();

    // sampleRate is a global in AudioWorkletGlobalScope
    this.processorSampleRate = options.processorOptions?.sampleRate ?? sampleRate;
    this.frameBuffer = new Float32Array(FRAME_SIZE);

    // 2ms attack, 200ms release — per-sample gain increments
    this.attackStep = 1 / (0.002 * this.processorSampleRate);
    this.releaseStep = 1 / (0.200 * this.processorSampleRate);

    this.port.onmessage = (event) => {
      if (event.data.type === 'init_port') {
        this.workerPort = event.data.port;
        this.workerPort.onmessage = this.handleWorkerMessage.bind(this);
      }
    };
  }

  private handleWorkerMessage(event: MessageEvent) {
    const { result } = event.data;
    if (result && result.probability !== undefined) {
      this.isVoiceActive = result.probability > this.threshold;
      // Clone state immediately on receipt — never hold a ref to a transferred buffer
      if (result.nextState) {
        const raw = result.nextState instanceof Float32Array
          ? result.nextState.buffer
          : result.nextState;
        this.vadStateBuffer = (raw as ArrayBuffer).slice(0);
      }
    }
  }

  public process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0] || !output || !output[0]) return true;

    const inChannel = input[0];

    for (let i = 0; i < inChannel.length; i++) {
      const sample = inChannel[i];

      // Accumulate samples into 512-frame buffer
      this.frameBuffer[this.bufferIndex++] = sample;
      if (this.bufferIndex >= FRAME_SIZE) {
        this.dispatchFrameToWorker();
        this.bufferIndex = 0;
      }

      // Sample-accurate gain smoothing
      const targetGain = this.isVoiceActive ? 1 : 0;
      if (this.currentGain < targetGain) {
        this.currentGain = Math.min(targetGain, this.currentGain + this.attackStep);
      } else if (this.currentGain > targetGain) {
        this.currentGain = Math.max(targetGain, this.currentGain - this.releaseStep);
      }

      // Apply gain to all output channels
      for (let c = 0; c < output.length; c++) {
        const sourceSample = input[c] ? input[c][i] : sample;
        output[c][i] = sourceSample * this.currentGain;
      }
    }

    return true;
  }

  private dispatchFrameToWorker() {
    if (!this.workerPort) return;

    // Clone the accumulated frame for transfer — this.frameBuffer stays intact
    const frameToProcess = new Float32Array(this.frameBuffer);

    // Build a fresh slice of the state for this dispatch
    const stateToSend = this.vadStateBuffer
      ? new Float32Array(this.vadStateBuffer.slice(0))
      : undefined;

    const msg: any = {
      // Use bare currentTime — AudioWorkletGlobalScope global, not globalThis.currentTime
      taskId: `vad_${currentTime}`,
      payload: {
        task: 'vad',
        pcm: frameToProcess,
        sr: this.processorSampleRate,
      }
    };
    if (stateToSend) msg.payload.state = stateToSend;

    const transferables: Transferable[] = [frameToProcess.buffer];
    if (stateToSend) transferables.push(stateToSend.buffer);

    this.workerPort.postMessage(msg, transferables);
  }
}

registerProcessor('vad-processor', VADProcessor);
