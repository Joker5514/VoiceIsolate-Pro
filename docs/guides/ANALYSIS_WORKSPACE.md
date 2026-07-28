# Full-Audio Analysis Workspace

Production analysis path for Engineer Mode (`/app/`).

## Modules

| Concern | Canonical path |
|---------|----------------|
| Features | `src/core/FeatureExtractor.js` |
| Segments | `src/core/SegmentMerger.js` |
| Whisper / faint speech | `src/core/WhisperLogic.js` |
| Full analysis | `src/core/FullAnalysis.js` |
| Recommendations | `src/core/RecommendationEngine.js` |
| **Analyzer ↔ WhisperHunter bridge** | `src/core/AnalyzerWhisperBridge.js` |
| DSP defaults | `src/core/DspCalibration.js` |
| Presets | `src/core/PresetCalibration.js` |
| Capabilities | `src/core/CapabilityChecker.js` |
| Worker | `src/workers/FullAnalysisWorker.js` |
| Host | `src/pipeline/FullAnalysisHost.js` |
| Audition | `src/pipeline/SourceAuditionEngine.js` |
| **USM (backend)** | `src/core/UniversalSourceMatrix.js` + `src/pipeline/USMNode.js` + `src/workers/USMWorker.js` |
| Export helper | `src/pipeline/ExportManager.js` |
| Timeline UI | `src/presentation/TimelineRenderer.js` |
| Transport sync | `src/presentation/TransportSync.js` |
| Engineer wiring | `public/app/lib/analysis-workspace.js` |

## Engineer Mode flow

1. **Upload** audio/video (local; decode deferred until Analyze/Process).
2. **Analyze Full Audio** — `FullAnalysisHost` → `FullAnalysisWorker` (features, segments, recommendations) with progress/heartbeat + stall timeout.
3. **USM backend (automatic)** — after analysis, `USMNode.ensureComputed()` runs once per file in `USMWorker` (classical NMF / optional ONNX). Stems are cached; UI shows a read-only **Detected Sources** chip list.
4. **Joint map** — `AnalyzerWhisperBridge` fuses analysis with WhisperHunter environment profiling:
   - **Protect** speech / whisper / difficult regions
   - **Suppress** music, broadband noise, hum, impulses, reverb, crowd/traffic
5. **WhisperHunter AI** (or **Analyze + WhisperHunter**) consumes the joint plan + `getSourceStems()` when available.
6. **Process** — pauses transport if playing (retains playhead, no auto-resume) → MLWorker / DSP once → Live-Mix.
7. **Playback / Compare Original** — transport A/B swaps original vs processed sample-accurately.
8. Live-Mix preview / export.

WhisperHunter alone still works without prior analysis, but quality is better when the workspace map is available (`app._lastFullAnalysis` / `app._jointIsolationPlan` / `app.getSourceStems()`).

Facades under `public/app/lib/*` re-export `/src/...` for stable relative URLs.

## Analysis object

See `analyzeAudio()` return value — includes segments, `visualLayers`, `recommendedPreset`, `recommendedStageConfig`, `recommendedProcessingPlan`, and `recommendation` (findings + reasons + confidence).

## Analysis → DSP map

| Finding | Response |
|---------|----------|
| Low SNR | Stronger NR / forensic or surveillance preset |
| Hum | Hum Removal / phase + hum strength |
| High reverb | Room Echo Reduction, ↑ dereverb |
| Whisper regions | Shallower gate, whisperLift in-region, protect consonants |
| Music bed | Aggressive Isolate, musicKill / bgSuppress |
| Overlaps | Reduced voiceIso, crosstalk cancel modest |
| High confidence | Auto-apply allowed |
| Low confidence | Recommend only; user must Apply |

## Universal Source Matrix — backend service

USM is **not** a user-facing Separate/mute/solo panel in Engineer Mode.

| Consumer | API |
|----------|-----|
| Analyzer (post-analysis) | `USMNode.ensureComputed()` → chips via `getSourceLabels()` |
| WhisperHunter | `getSourceStems()` for per-source PCM targets |
| Audition strip | `buildFromUSM()` + mute/solo/gain on layers only |

### Internal API (`USMNode`)

```js
await usmNode.ensureComputed(channels, sampleRate, { mode: 'auto', numSources: 6 });
usmNode.getSourceLabels(); // [{ id, label, confidence, quality }]
usmNode.getSourceStems();  // [{ id, label, pcm, confidence, quality, method }]
usmNode.isReady();
```

### Live-Mix contract

- **Never** recompute USM on slider drag, mute, solo, or preset apply.
- Mute/solo/gain on stems = `SourceAuditionEngine` / Live-Mix gains only.
- Optional `refine(query)` remains a deliberate one-shot (not wired to Engineer sliders).

Not used on the Live low-latency path (keep voice / ambient / music coarse stems there).

## Honesty rules

- No fabricated words or ASR transcription unless a local ASR model is explicitly bundled later.
- Layer quality badges: high (true stems), medium (ML/classical mix), low (best-effort residual).
- Empty lanes show “not detected” — never decorative fake regions.
- USM cannot produce a deterministic “one fader per atom of sound”; K semantic components + query refine is the practical ceiling.

## Performance

- Default frame 25 ms / hop 10 ms classical analysis.
- Long files: mono downmix for analysis; worker + heartbeats.
- USM classical path in `USMWorker` with progress/heartbeat and hard timeout.
- Lazy audition buffers; dispose on Clear / new file (host responsibility).
- Collapsible Engineer panels persist open/closed state in `localStorage` without re-processing.
