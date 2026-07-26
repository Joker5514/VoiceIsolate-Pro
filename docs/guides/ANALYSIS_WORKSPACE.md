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
| Export helper | `src/pipeline/ExportManager.js` |
| Timeline UI | `src/presentation/TimelineRenderer.js` |
| Transport sync | `src/presentation/TransportSync.js` |
| Engineer wiring | `public/app/lib/analysis-workspace.js` |

## Engineer Mode flow

1. **Upload** audio/video (local decode only).
2. **Analyze Full Audio** — classical full-file map (speech, whisper, music, noise, hum, impulses).
3. **Joint map** — `AnalyzerWhisperBridge` fuses analysis with WhisperHunter environment profiling:
   - **Protect** speech / whisper / difficult regions (amplify & isolate)
   - **Suppress** music, broadband noise, hum, impulses (horns, barks, claps), reverb, crowd/traffic
4. **WhisperHunter AI** (or **Analyze + WhisperHunter**) consumes the joint plan for preset + slider morph + single-pass isolation.
5. Live-Mix preview / export.

WhisperHunter alone still works without prior analysis, but quality is better when the workspace map is available (`app._lastFullAnalysis` / `app._jointIsolationPlan`).

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

## Honesty rules

- No fabricated words or ASR transcription unless a local ASR model is explicitly bundled later.
- Layer quality badges: high (true stems), medium (ML/classical mix), low (best-effort residual).
- Empty lanes show “not detected” — never decorative fake regions.

## Performance

- Default frame 25 ms / hop 10 ms classical analysis.
- Long files: mono downmix for analysis; yield via worker.
- Lazy audition buffers; dispose on Clear / new file (host responsibility).
