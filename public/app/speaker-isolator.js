// public/app/speaker-isolator.js
// Targeted Voice Isolation — main thread controller.
// Drives ml-worker.js for real-time ECAPA-TDNN speaker gating.

import { saveVoiceprint, loadVoiceprint, adaptVoiceprint, cosineSimilarity }
  from './voiceprint-store.js';

const SIMILARITY_ISOLATE  = 0.82;
const SIMILARITY_MUTE     = 0.82;
const EMA_CONFIRM_ALPHA   = 0.05;

export const IsolationMode = Object.freeze({
  ISOLATE: 'ISOLATE',
  MUTE:    'MUTE',
  OFF:     'OFF'
});

export class SpeakerIsolator {
  #mlWorker     = null;
  #mode         = IsolationMode.OFF;
  #targetId     = null;
  #enrollment   = null;
  #sessionFrames = [];
  #onEvent      = null;

  constructor(mlWorker, onEvent) {
    this.#mlWorker = mlWorker;
    this.#onEvent  = onEvent ?? (() => {});
  }

  async enroll(speakerId, pcmBuffer) {
    if (!(pcmBuffer instanceof Float32Array) || pcmBuffer.length < 16000 * 3) {
      throw new Error('Enrollment requires ≥3s of 16kHz mono PCM (Float32Array)');
    }
    return new Promise((resolve, reject) => {
      const handler = ({ data }) => {
        if (data.type === 'voiceprintEnrolled') {
          this.#mlWorker.removeEventListener('message', handler);
          if (data.success && data.embedding) {
            this.#enrollment = new Float32Array(data.embedding);
            this.#targetId   = speakerId;
            saveVoiceprint(speakerId, this.#enrollment);
            resolve({ speakerId, dims: this.#enrollment.length });
          } else {
            reject(new Error('ECAPA-TDNN enrollment failed in worker'));
          }
        } else if (data.type === 'error') {
          this.#mlWorker.removeEventListener('message', handler);
          reject(new Error(data.payload?.message ?? 'Worker error'));
        }
      };
      this.#mlWorker.addEventListener('message', handler);
      this.#mlWorker.postMessage({
        type: 'enrollVoiceprint',
        payload: { pcm: pcmBuffer, speakerId }
      });
    });
  }

  async loadEnrollment(speakerId) {
    const emb = await loadVoiceprint(speakerId);
    if (!emb) throw new Error(`No voiceprint found for id: ${speakerId}`);
    this.#enrollment = emb;
    this.#targetId   = speakerId;
    this.#mlWorker.postMessage({
      type: 'setVoiceprint',
      payload: { embedding: Array.from(emb) }
    });
    return { speakerId, dims: emb.length };
  }

  setMode(mode) {
    if (!Object.values(IsolationMode).includes(mode)) {
      throw new Error(`Invalid mode: ${mode}`);
    }
    this.#mode = mode;
    this.#mlWorker.postMessage({
      type: 'setIsolationMode',
      payload: { mode, threshold: SIMILARITY_ISOLATE }
    });
    this.#onEvent({ type: 'MODE_CHANGED', mode });
  }

  getMode()     { return this.#mode; }
  getTargetId() { return this.#targetId; }

  async confirmMatch(sessionEmbedding) {
    if (!this.#targetId) return;
    await adaptVoiceprint(this.#targetId, sessionEmbedding, EMA_CONFIRM_ALPHA);
    this.#enrollment = await loadVoiceprint(this.#targetId);
    this.#mlWorker.postMessage({
      type: 'setVoiceprint',
      payload: { embedding: Array.from(this.#enrollment) }
    });
    this.#onEvent({ type: 'VOICEPRINT_ADAPTED', speakerId: this.#targetId });
  }

  async rejectMatch() {
    this.#onEvent({ type: 'MATCH_REJECTED', speakerId: this.#targetId });
  }

  dispose() {
    this.#mode = IsolationMode.OFF;
    this.#enrollment = null;
    this.#sessionFrames = [];
  }
}
