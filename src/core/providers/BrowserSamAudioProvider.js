/**
 * Browser-local SAM-Audio provider.
 *
 * INTENTIONALLY UNAVAILABLE: no verified ONNX/WebGPU/WASM export of Meta SAM-Audio
 * is registered in this repository. This class exists so capability queries are
 * honest and UI can show “not supported in browser” without claiming support.
 */
'use strict';

import { AudioIsolationProvider } from './AudioIsolationProvider.js';

export class BrowserSamAudioProvider extends AudioIsolationProvider {
  get id() {
    return 'sam-browser';
  }

  async getCapabilities() {
    return {
      available: false,
      mode: 'browser',
      backends: [],
      live: false,
      offline: false,
      browserSam: false,
      localWorker: false,
      reasons: [
        'no-verified-sam-audio-onnx',
        'sam-audio-is-gated-pytorch-cuda',
        'browser-claim-forbidden-without-export',
      ],
    };
  }

  async isolate() {
    throw new Error(
      '[VIP][sam-browser] Browser-local SAM-Audio is not available. '
      + 'Use LocalSamAudioWorkerProvider (localhost worker) or onnx-local (USM/BSRNN).',
    );
  }
}

export default BrowserSamAudioProvider;
