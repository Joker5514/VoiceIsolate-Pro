/**
 * voice-isolator-worklet.js
 *
 * Deprecated pass-through shim. The real implementation is /app/dsp-processor.js
 * (processor name: dsp-processor). Any call site loading this file is misconfigured.
 *
 * Bug #5 fix: now posts an error event and stops immediately so callers are
 * alerted rather than silently passing unprocessed audio through.
 */

class VoiceIsolatorLegacyShim extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.postMessage({
      type: 'deprecated-worklet',
      message: 'voice-isolator-worklet.js is a legacy shim. Use /app/dsp-processor.js (processor name: dsp-processor).'
    });
    this.port.postMessage({
      type: 'error',
      code: 'LEGACY_WORKLET',
      message: 'voice-isolator-worklet.js is a deprecated pass-through shim. ' +
               'Load /app/dsp-processor.js and register processor "dsp-processor" instead.'
    });
  }

  process(inputs, outputs) {
    this.port.postMessage({ type: 'error', code: 'LEGACY_WORKLET_STOPPED' });
    return false; // disconnect and stop — do NOT silently pass audio through unprocessed
  }
}

registerProcessor('voice-isolator-worklet', VoiceIsolatorLegacyShim);
