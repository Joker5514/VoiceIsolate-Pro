/**
 * DIARIZATION_WIRING.md — app.js integration patch
 * ════════════════════════════════════════════════════════════════
 * This file documents the EXACT changes needed to wire
 * diarization-timeline.js and isolation-controls.js into the
 * existing publicappapp.js boot sequence.
 *
 * Copilot instructions:
 *   1. Apply each numbered patch block IN ORDER to app.js.
 *   2. Never modify the STFT / SAB contract sections.
 *   3. Keep all existing imports / requires.
 * ════════════════════════════════════════════════════════════════
 */

// ── PATCH 1: Load helpers as classic scripts and bind from `window` ──
//
//   `public/app/app.js` is loaded by `public/app/index.html` as a classic
//   `<script src="./app.js">`, so DO NOT add ESM `import ... from ...`
//   statements here unless the entrypoint is explicitly converted to
//   `<script type="module">`.
//
//   Instead, load the helper files BEFORE `app.js` in `public/app/index.html`:
//
//   <script src="./diarization-timeline.js"></script>
//   <script src="./isolation-controls.js"></script>
//   <script src="./app.js"></script>
//
//   Ensure those helper files expose their APIs on `window`:
//     - `window.DiarizationTimeline = { initDiarizationTimeline, onDiarizationResult, seekTimeline }`
//     - `window.IsolationControls = { initIsolationControls, updateSpeakerCards, setActiveSpeakerCard }`
//
//   Then, in `public/app/app.js`, INSERT after the existing
//   `import * as ort from 'onnxruntime-web';` line:
//
const { initDiarizationTimeline, onDiarizationResult, seekTimeline } =
  window.DiarizationTimeline;
const { initIsolationControls, updateSpeakerCards, setActiveSpeakerCard } =
  window.IsolationControls;


// ── PATCH 2: Extend App state object ────────────────────────────
//
//   INSIDE the `const App = { ... }` literal, add after the existing `state` block:
//
  diarization: {
    segments:      [],
    duration:      0,
    speakerCount:  0,
    activeSpeaker: null,
  },
//
//   END PATCH 2


// ── PATCH 3: Wire diarization in initLiveEngine() ───────────────
//
//   At the END of initLiveEngine(), AFTER `bindButtons()` and
//   BEFORE `connectLiveInput()`, add:
//
  // ── Diarization timeline bootstrap ──────────────────────────
  initDiarizationTimeline({
    mlWorker:      App.mlWorker,
    audioContext:  App.audioContext,
    onSpeakerSelect: (speakerId) => {
      App.diarization.activeSpeaker = speakerId;
      setActiveSpeakerCard(speakerId);
    },
  });

  initIsolationControls({
    mlWorker:     App.mlWorker,
    audioContext: App.audioContext,
    mediaStream:  App.mediaStream,
  });
//
//   END PATCH 3


// ── PATCH 4: ml-worker message router extension ─────────────────
//
//   INSIDE App.mlWorker.onmessage, extend the switch/case block:
//   Find `case 'stats': updateWorkerStats(payload); break;`
//   and ADD the following cases after it:
//
    case 'diarization': {
      const { segments = [], duration = 0, speakerCount = 0 } = payload;
      App.diarization.segments     = segments;
      App.diarization.duration     = duration;
      App.diarization.speakerCount = speakerCount;

      // Feed the canvas timeline
      onDiarizationResult({ segments, duration });

      // Rebuild isolation control cards
      // Extract speaker map from timeline module's internal state
      // (timeline exports speakers via a getter — or use the segments directly)
      const speakerMap = {};
      const palette = ['#3b82f6','#a855f7','#10b981','#f59e0b',
                        '#ef4444','#06b6d4','#84cc16','#f97316'];
      let colorIdx = 0;
      segments.forEach(seg => {
        if (!speakerMap[seg.speakerId]) {
          speakerMap[seg.speakerId] = {
            label:  seg.label ?? `Speaker ${seg.speakerId}`,
            color:  palette[colorIdx++ % palette.length],
            volume: 1.0,
            muted:  false,
            solo:   false,
          };
        }
      });
      updateSpeakerCards(speakerMap);
      break;
    }

    case 'voiceprintEnrolled': {
      document.getElementById('voiceprint-status')?.classList
        .replace('voiceprint-status--recording', 'voiceprint-status--ready');
      break;
    }

    case 'voiceprintCleared': {
      const el = document.getElementById('voiceprint-status');
      if (el) { el.textContent = 'Voiceprint cleared'; el.className = 'voiceprint-status voiceprint-status--idle'; }
      break;
    }
//
//   END PATCH 4


// ── PATCH 5: Playback position sync ─────────────────────────────
//
//   Find the requestAnimationFrame visualizer loop in app.js.
//   It likely calls drawWaveform() or updateAnalyser().
//   ADD this single line inside that RAF callback:
//
  seekTimeline(App.audioContext?.currentTime ?? 0);
//
//   END PATCH 5


// ── PATCH 6: SLIDER_REGISTRY additions ──────────────────────────
//
//   Append these entries to the existing SLIDER_REGISTRY array:
//
  // Isolation panel sliders
  { id: 'isolation-confidence', key: 'ecapaSimilarityThreshold',
    target: 'worker', transform: v => Number(v) / 100 },
  { id: 'isolation-bg-volume',  key: 'backgroundVolume',
    target: 'worker', transform: v => Number(v) / 100 },
//
//   END PATCH 6


// ══════════════════════════════════════════════════════════════════
// ml-worker.js: new message handlers to add
// ══════════════════════════════════════════════════════════════════
//
// In the switch(type) block of self.onmessage, add:
//
  case 'isolateSpeaker': {
    const { speakerId } = payload;
    Worker.params.targetSpeakerId = speakerId ?? null;
    break;
  }

  case 'speakerVolumes': {
    // payload = { [speakerId]: 0..1 }
    Worker.params.speakerVolumes = payload;
    break;
  }

  case 'enrollFromDiarization': {
    const { speakerId } = payload;
    if (!Worker.diarizationSegments || !Worker.diarizationBuffer) break;
    // Extract PCM slices belonging to speakerId, concatenate, enroll
    const segs = Worker.diarizationSegments.filter(s => s.speakerId === speakerId);
    if (segs.length === 0) { self.postMessage({ type: 'error', payload: { message: 'No segments for speaker' } }); break; }
    const sampleRate = Worker.shared.sampleRate ?? 48000;
    const totalLen   = segs.reduce((acc, s) => acc + Math.round((s.end - s.start) * sampleRate), 0);
    const pcm        = new Float32Array(totalLen);
    let   offset     = 0;
    segs.forEach(seg => {
      const start = Math.round(seg.start * sampleRate);
      const end   = Math.round(seg.end   * sampleRate);
      const slice = Worker.diarizationBuffer.subarray(start, end);
      pcm.set(slice, offset);
      offset += slice.length;
    });
    await enrollVoiceprint(pcm);
    self.postMessage({ type: 'voiceprintEnrolled', payload: { speakerId } });
    break;
  }
//
// ══════════════════════════════════════════════════════════════════
