/**
 * VoiceIsolate Pro — AudioWorkletProcessor
 * Adaptive noise floor soft-gate with per-sample voice suppression.
 * Registered as 'voice-isolator' — load via AudioContext.audioWorklet.addModule().
 */
class VoiceIsolatorProcessor extends AudioWorkletProcessor {
    static get parameterDescriptors() {
        return [
            { name: 'strength',   defaultValue: 0.85, minValue: 0, maxValue: 1 },
            { name: 'gateFloor', defaultValue: 0.01, minValue: 0, maxValue: 1 }
        ];
    }
    constructor() {
        super();
        this._floor = 0.0;
        this._alpha = 0.995;
    }
    process(inputs, outputs, params) {
        const inp = inputs[0]?.[0];
        const out = outputs[0]?.[0];
        if (!inp || !out) return true;
        const strength  = params.strength[0]  ?? 0.85;
        const gateFloor = params.gateFloor[0] ?? 0.01;
        let rms = 0;
        for (let i = 0; i < inp.length; i++) rms += inp[i] * inp[i];
        this._floor = this._alpha * this._floor + (1 - this._alpha) * Math.sqrt(rms / inp.length);
        const thresh = Math.max(gateFloor, this._floor * 1.5);
        for (let i = 0; i < inp.length; i++) {
            const s = inp[i];
            const gate = Math.abs(s) > thresh ? 1.0 : Math.abs(s) / thresh;
            out[i] = s * gate * strength;
        }
        return true;
    }
}
registerProcessor('voice-isolator', VoiceIsolatorProcessor);
