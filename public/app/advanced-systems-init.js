// public/app/advanced-systems-init.js
// Wiring for Speaker Isolator, Covert Detector, and LipSync Monitor.
// Import and call initAdvancedSpeakerSystems(videoEl?) after initLiveEngine().

import { SpeakerIsolator, IsolationMode } from './speaker-isolator.js';
import { LipSyncMonitor }                 from './mediapipe-lip-sync.js';

let covertWorker   = null;
let speakerIso     = null;
let lipSyncMonitor = null;

export { IsolationMode };

export async function initAdvancedSpeakerSystems(App, videoElement = null) {
  // 1. Covert detector — dedicated worker
  covertWorker = new Worker(
    new URL('./covert-detector.js', import.meta.url),
    { type: 'classic' }
  );
  covertWorker.postMessage({
    type:    'init',
    payload: {
      sampleRate:    App.audioContext.sampleRate,
      fftSize:       2048,
      modelBasePath: '/app/models'
    }
  });

  covertWorker.onmessage = ({ data }) => {
    switch (data.type) {
      case 'COVERT_SPEAKER_DETECTED':
        dispatchCovertAlert(data);
        break;
      case 'REQUEST_WHISPER_STT':
        App.whisperWorker?.postMessage({ type: 'transcribe', payload: data.payload });
        break;
      case 'modelsReady':
        console.info('[CovertDetector] Models loaded, detection active');
        break;
      case 'DIRECTION_ESTIMATE':
        window.dispatchEvent(new CustomEvent('covertDirectionEstimate', {
          detail: { degrees: data.degrees }
        }));
        break;
    }
  };

  // 2. Speaker Isolator
  speakerIso = new SpeakerIsolator(App.mlWorker, event => {
    console.info('[SpeakerIsolator]', event);
    if (event.type === 'VOICEPRINT_ADAPTED') {
      showToast?.(`Voiceprint updated for ${event.speakerId}`);
    }
  });

  // 3. Register known speakers with covert detector on enrollment
  App.mlWorker?.addEventListener('message', ({ data }) => {
    if (data.type === 'voiceprintEnrolled' && data.embedding) {
      covertWorker.postMessage({
        type:    'registerSpeaker',
        payload: { id: 'TARGET', embedding: data.embedding }
      });
    }
  });

  // 4. Feed spectral frames to covert detector from AudioWorklet
  App.liveNode?.port.addEventListener('message', ({ data }) => {
    if (data.type === 'spectralFrame') {
      covertWorker.postMessage({
        type:    'frame',
        payload: {
          mag:               data.mag,
          phase:             data.phase,
          timestamp:         data.timestamp,
          audioSnippetBase64: data.snippetB64 ?? null
        }
      });
    }
  });

  // 5. Optional MediaPipe lip-sync
  if (videoElement) {
    lipSyncMonitor = new LipSyncMonitor();
    await lipSyncMonitor.init(videoElement, covertWorker);
  }

  return { speakerIso, covertWorker, lipSyncMonitor };
}

export function setIsolationMode(mode) {
  speakerIso?.setMode(mode);
  document.getElementById('isolation-mode-indicator')
    ?.setAttribute('data-mode', mode);
}

export async function enrollFromMic(App, speakerId, durationSeconds = 5) {
  if (!App.audioContext) throw new Error('AudioContext not initialized');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000, channelCount: 1 }
  });
  const offline = new OfflineAudioContext(1, 16000 * durationSeconds, 16000);
  const src     = offline.createMediaStreamSource(stream);
  src.connect(offline.destination);
  const rendered = await offline.startRendering();
  stream.getTracks().forEach(t => t.stop());
  const pcm = rendered.getChannelData(0);
  return speakerIso.enroll(speakerId, pcm);
}

export function confirmSpeakerMatch(sessionEmbedding) {
  return speakerIso?.confirmMatch(sessionEmbedding);
}

export function rejectSpeakerMatch() {
  return speakerIso?.rejectMatch();
}

export function disposeAdvancedSystems() {
  covertWorker?.terminate();
  lipSyncMonitor?.dispose();
  speakerIso?.dispose();
  covertWorker = lipSyncMonitor = speakerIso = null;
}

function dispatchCovertAlert(event) {
  window.dispatchEvent(new CustomEvent('covertSpeakerDetected', { detail: event }));
  console.warn(
    `[COVERT DETECTED] t=${event.timestamp}ms | ` +
    `confidence=${(event.confidence * 100).toFixed(1)}% | ` +
    `cluster=${event.speakerClusterId} | ` +
    `flatness=${event.diagnostics?.spectralFlatness} | ` +
    `F0=${event.diagnostics?.f0dB}dB`
  );
}
