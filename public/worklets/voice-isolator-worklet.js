/**
 * voice-isolator-worklet.js
 *
 * Canonical shim worklet for legacy registrations.
 * The real implementation lives in /app/dsp-processor.js under the processor
 * name `dsp-processor`. This legacy worklet exists so older code paths do not
 * fail when requesting /worklets/voice-isolator-worklet.js.
 *
 * It performs transparent pass-through only, and posts a deprecation notice.
 */

class VoiceIsolatorLegacyShim extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.postMessage({
      type: 'deprecated-worklet',
      message: 'voice-isolator-worklet.js is a legacy shim. Use /app/dsp-processor.js (processor name: dsp-processor).'
    });
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output) return true;
    const channels = Math.min(input.length, output.length);
    for (let ch = 0; ch < channels; ch++) {
      output[ch].set(input[ch]);
    }
    return true;
  }
}

registerProcessor('voice-isolator-worklet', VoiceIsolatorLegacyShim);
