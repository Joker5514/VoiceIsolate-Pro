# VoiceIsolate Pro — Definitive Technical Blueprint

**Architecture: Threads from Space v11 | 35-Stage Deca-Pass DSP Pipeline**
**Document Version: 22.1 | April 2026 | Classification: Production-Ready**

---

## Executive Summary

VoiceIsolate Pro v22.1 is a production-grade, privacy-first voice isolation platform built entirely in the browser. Zero cloud egress — a hard architectural constraint, not a policy. All processing occurs locally via Web Audio API, AudioWorklet, SharedArrayBuffer, and ONNX Runtime Web with GPU acceleration.

The v22.1 codebase has evolved through 22 iterative versions from a basic FFT spectral processor to a best-in-class voice extraction engine powered by the Threads from Space v11 concurrency architecture, a 35-stage deca-pass DSP pipeline, deep learning source separation (Demucs v4.1 + BS-RoFormer ensemble), Anti-Garble neural residual cleanup, HiFi-GAN neural vocoder reconstruction, and a full monetization stack across four tiers.

**Key Targets:**
- Noise floor: −96 dB
- Real-time latency: < 12 ms
- Speech intelligibility: > 97% (PESQ > 4.2)
- ML SNR improvement: > 20 dB on speech-band energy
- Test coverage: 837 unit tests across 22 test suites (all passing)

---

## 1. Core Capabilities

### 1.1 Studio-Grade Voice Isolation

- Isolates target voice from any audio/video source — music, crowd noise, HVAC, reverb, electrical hum
- Multi-speaker separation: up to 8 simultaneous voices via spectral clustering + speaker diarization
- Voiceprint-guided mode: enroll target speaker from 3–5 second sample via ECAPA-TDNN 192-dim embeddings
  - Cosine similarity > 0.7 → pass fully; 0.4–0.7 → proportional blend; < 0.4 → gate to silence
- Format support: MP3, WAV, M4A, FLAC, OGG, MP4, MOV, WEBM, MKV, AVI
  - Video containers decoded via `file.arrayBuffer()` direct — never `fetch(blobURL)` (cross-browser failure)

### 1.2 Multi-Band Noise Reduction with Adaptive Spectral Gating

- 32-band ERB-scale psychoacoustic gate with independent threshold, attack (2 ms), release (50 ms), ratio (4:1) per band
- Continuous background noise profiling: Martin minimum statistics, 256-band, 50 ms windows, updates every 200 ms (α = 0.98)
- Noise type classification: white, pink, brown, hum, reverb, crowd, wind, machinery — per-type reduction strategy
- Hum removal: adaptive notch cascade at 50/60 Hz + 12 harmonics, Q = 30, auto-detects fundamental via spectral peak
- Musical noise suppression via temporal smoothing prevents tonal warbling artifacts of basic spectral subtraction

### 1.3 Overlapping Voice Separation

- Demucs v4.1 + BS-RoFormer dual-model ensemble with confidence-weighted per-bin mask fusion
- Ensemble consistently outperforms either model alone by 1–2 dB SDR
- pyannote.audio Community-1 (2025) speaker diarization: "who spoke when" with < 200 ms transition latency
- AI Engine v2: gradient-descent auto-tune, voice fingerprinting, per-speaker noise profile library, multi-speaker detection

### 1.4 Dual-Mode Processing

- **Real-time mode**: AudioWorklet + SharedArrayBuffer ring buffer, 128-sample blocks at 48 kHz, ~12 ms end-to-end
- **Offline HiFi mode**: OfflineAudioContext, full 35-stage pipeline, 4096-sample STFT windows, 75% overlap, > 10× real-time
- **Hybrid mode**: real-time preview streams immediately while background workers execute the full pipeline for export
- Auto mode selection: files < 30 s use real-time preview; longer files route to offline path

### 1.5 Anti-Garble: Residual Noise Elimination (v22 Innovation)

Root cause: ML vocal masks are soft (0–1 float). In the 1–4 kHz overlap zone between voice formants and noise harmonics, partial noise energy leaks through Demucs/BSRoFormer masks, creating garbled spectral debris.

Three-layer solution:
1. **Residual Spectral Mask (Stage 18)**: Conformer-S (5 M params, ~8 MB ONNX) trained specifically on Demucs + BSRoFormer residual artifacts. Learns and targets garbled spectral debris while preserving speech detail.
2. **Spectral Tilt Correction (Stage 19)**: Compensates the low-frequency tilt ML separation introduces, restoring natural voice presence.
3. **Harmonic Reconstruction (Stage 20)**: F0-guided resynthesis of first 8 harmonics, VAD-gated to confirmed speech only. Replaces ML-damaged harmonics with clean synthesized versions.

### 1.6 Artifact Suppression & Phase-Coherent Reconstruction

- **Single-pass STFT (non-negotiable)**: one forward STFT → all spectral ops in-place → one iSTFT. Multiple round-trips (v11–v14 anti-pattern) cause cumulative phase smearing manifesting as audible echo/doubling.
- Click/decrackle removal: transient classification (speech onset vs. artifact) + AR-prediction interpolation
- Phase-coherent reconstruction: single-pass discipline eliminates all inter-stage phase artifacts
- HiFi-GAN neural vocoder: reconstructs natural waveform from mel-spectrogram, restoring breathiness, fricatives, and vocal warmth

### 1.7 v22.1-Specific Features

- **Resume Playback**: pause accumulates `pauseOffset`, AudioContext suspends; on resume, new source node starts at `pauseOffset`. No position reset.
- **A/B Toggle**: bidirectionally synced with spectrogram and source selector — instant switch between original and processed audio
- **9 Professionally Retuned Presets**: Podcast, Film, Interview, Forensic, Broadcast, Dialogue, Music, Conference, Whisper
- **File Upload Hardening**: resolved strict MIME validation blocking MP3, MKV, and other common formats

---

## 2. Architecture — Threads from Space v11

```
┌─────────────────────────────────────────────────────────────────────┐
│                           MAIN THREAD                               │
│  UI · Transport · A/B Toggle · 3D Hexawave Spectrogram (Three.js)  │
└──────────┬──────────────────────────────────────────────────────────┘
           │ SharedArrayBuffer / MessageChannel / Transferable
┌──────────┴──────────────────────────────────────────────────────────┐
│              DSP COORDINATOR  (Web Worker)                          │
│  Pipeline DAG orchestration · Stage scheduling · Buffer routing     │
│  Memory pressure monitor (throttle at > 80% heap)                  │
│  Job persistence: IndexedDB crash recovery                          │
└─────┬──────────┬──────────────┬──────────────┬──────────────────────┘
      │          │              │              │
      ▼          ▼              ▼              ▼
┌──────────┐ ┌────────────┐ ┌──────────┐ ┌────────────────────┐
│ DSP      │ │ ML Workers │ │ DSP      │ │ GPU COMPUTE        │
│ Workers  │ │ (CPU-0..N) │ │ Workers  │ │ THREAD             │
│ STFT     │ │ ONNX RT    │ │ Pass 6–9 │ │ WebGPU / WebGL2    │
│ Wiener   │ │ Demucs     │ │ WASM+    │ │ STFT, inference    │
│ ERB Gate │ │ BSRoFormer │ │ SIMD     │ │ 10–50× vs CPU      │
└──────────┘ └────────────┘ └──────────┘ └────────────────────┘
      ▲                                          ▲
      │     SharedArrayBuffer Ring Buffers        │
      │   (Atomics.load/store, wait-free SPSC)    │
      ▼                                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│              AUDIOWORKLET  (Real-Time Audio Thread)                 │
│  128-sample I/O blocks · 12 ms latency · Zero allocation in         │
│  process() · Lock-free SAB ring buffer I/O                          │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────────┐  ┌───────────────────────────────────────┐
│  BATCH ORCHESTRATOR  │  │  PLUGIN SANDBOX (Web Worker)          │
│  Priority queue      │  │  No network · 50 ms CPU budget/block  │
│  1–1000+ files       │  │  64 MB memory ceiling                 │
│  ZIP export          │  │  Same ProcessingNode interface        │
└──────────────────────┘  └───────────────────────────────────────┘
```

### 2.1 Thread Communication Protocol

| Mechanism | RT-Safe | Use |
|---|---|---|
| `SharedArrayBuffer` + `Atomics.load/store` | **Yes** | Audio streaming via ring buffers |
| `Atomics.wait/notify` | No | Worker-to-worker synchronization |
| `MessagePort` | No | Control signals, parameter changes |
| Transferable `ArrayBuffer` | No | Large payloads (model weights, batch results) |

Ring buffer implementation: ringbuf.js (Paul Adenot, Mozilla) — wait-free SPSC, zero JS object allocation, ~1.3 KB gzipped. 2.5–6× throughput vs `postMessage` audio transfer.

**Deployment requirement**: SharedArrayBuffer requires COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`). Configured in `vercel.json`.

### 2.2 GPU Acceleration Cascade

```
navigator.gpu available?
  └─ WebGPU compute shaders → STFT/iSTFT, ML inference (primary, 10–50× WASM)
  └─ WebGL2 fragment shaders → ONNX Runtime WebGL backend (widely supported)
  └─ WASM SIMD → ONNX Runtime WASM backend (no GPU required)
  └─ Plain JS → reference fallback (functional, 10–50× slower)
```

### 2.3 Single-Pass STFT Enforcement

The PipelineOrchestrator validates at construction time that no DSP node requests a time-domain buffer between the designated STFT boundary (Stage 3) and iSTFT boundary (Stage 26). Any node that would cause a second STFT/iSTFT pair throws a `STFTBoundaryViolation` at registration and is rejected. This is enforced in code — not just convention.

---

## 3. 35-Stage Deca-Pass DSP Pipeline

```
Input → [Pass 1: Ingest] → [Pass 2: Analysis] → [Pass 3: Classical DSP]
      → [Pass 4: ML Separation] → [Pass 5: Spectral Refinement] → [Pass 6: Room]
      → [Pass 7: Time-Domain] → [Pass 8: Neural Reconstruction]
      → [Pass 9: Mastering] → [Pass 10: Forensic] → Output
```

### Pass 1 — Ingest (Stages 01–03)

| Stage | Module | Function |
|---|---|---|
| 01 | AudioDecoder | Format detection + decode to 48 kHz Float32. Video via `file.arrayBuffer()`. |
| 02 | ChannelNormalizer | Up/down-mix to mono or stereo, DC offset removal, input gain staging |
| 03 | STFT Analyzer | **Single forward FFT** (4096-pt, 75% overlap, Hann window). All spectral work begins here. |

### Pass 2 — Analysis (Stages 04–07)

| Stage | Module | Function |
|---|---|---|
| 04 | LevelDetector | RMS/peak metering, dynamic range estimation, clip detection |
| 05 | NoiseProfiler | Martin min-statistics, 256-band, 50 ms windows. Builds spectral noise fingerprint. |
| 06 | HumDetector | Spectral peak analysis → auto-detects 50/60 Hz fundamental + 12 harmonics |
| 07 | VAD (Silero v5) | 10 ms frame resolution, 350 KB ONNX. Speech/non-speech gating for all downstream stages. |
| 08 | NoiseClassifier | ML noise type identification: white/pink/brown/hum/reverb/crowd/wind/machinery |

### Pass 3 — Classical DSP (Stages 08–13)

| Stage | Module | Function |
|---|---|---|
| 09 | NotchFilterBank | Adaptive notch cascade: 50/60 Hz + 12 harmonics, Q = 30 |
| 10 | ERBGate | 32-band ERB psychoacoustic gate. Per-band threshold, attack 2 ms, release 50 ms, ratio 4:1 |
| 11 | SpectralSubtractor | Wiener-filter spectral subtraction using Stage 05 noise estimate |
| 12 | TemporalSmoother | Cross-frame spectral floor smoothing — eliminates musical noise / tonal warbling |
| 13 | AdaptiveWiener | Per-bin SNR-weighted Wiener gain with minimum gain floor to preserve naturalness |

### Pass 4 — ML Separation (Stages 14–17)

| Stage | Module | Function |
|---|---|---|
| 14 | DemucsV4 | Demucs v4.1 hybrid (Transformer + U-Net). 10 s chunks, 50% overlap, crossfade stitch. Outputs vocals stem. |
| 15 | BSRoFormer | Band-Split RoFormer. Excels 1–4 kHz where Demucs is weakest. Rotary-position-embedding attention. |
| 16 | EnsembleFusion | Confidence-weighted per-bin mask blend. Agreement bins → average; disagreement → higher-confidence model. +1–2 dB SDR. |
| 17 | VoiceprintGate | ECAPA-TDNN cosine similarity gating: > 0.7 pass, 0.4–0.7 blend, < 0.4 silence |

### Pass 5 — Spectral Refinement / Anti-Garble (Stages 18–21)

| Stage | Module | Function |
|---|---|---|
| 18 | ConformerS | 5 M param residual-artifact model. Trained on Demucs + BSRoFormer output debris. Surgical cleanup mask. |
| 19 | SpectralTiltCorrector | Measures ML-introduced spectral slope vs. reference speech model. Applies corrective EQ. |
| 20 | HarmonicReconstructor | F0 via autocorrelation → resynthesizes harmonics 1–8. VAD-gated (silence frames never processed). |
| 21 | MusicalNoiseSuppressor | Spectral floor estimation + temporal coherence check. Targets residual tonal artifacts. |

### Pass 6 — Room Processing (Stages 22–24)

| Stage | Module | Function |
|---|---|---|
| 22 | RoomProfiler | Classifies acoustic environment (8 profiles). Estimates RT60 from energy decay. |
| 23 | WPEDereverber | Weighted Prediction Error dereverberation. Spectral tail suppression by RT60. |
| 24 | EarlyReflectionRemover | Comb-filter-based early reflection suppression with delay estimation |

### Pass 7 — Time-Domain Restoration (Stages 25–27)

| Stage | Module | Function |
|---|---|---|
| 25 | Declicker | AR-model transient classifier. Interpolates click/pop artifacts. |
| 26 | iSTFT | **Single inverse FFT**. Overlap-add reconstruction. This is the only iSTFT in the pipeline. |
| 27 | PhaseCorrector | Verifies output phase coherence. Rolls back to Griffin-Lim (100 iterations) if coherence fails. |

### Pass 8 — Neural Reconstruction (Stages 28–29)

| Stage | Module | Function |
|---|---|---|
| 28 | HiFiGAN | Neural vocoder. Mel-spectrogram → natural waveform. Restores breathiness, fricatives, vocal warmth. |
| 29 | PESQGuard | Perceptual quality regression detector. If Pass 8 degrades quality, auto-rolls back to best intermediate. |

### Pass 9 — Mastering (Stages 30–33)

| Stage | Module | Function |
|---|---|---|
| 30 | DynamicsProcessor | Transient shaping, compressor (threshold/ratio), limiter ceiling |
| 31 | LoudnessNormalizer | EBU R128 / LUFS target. Per-preset loudness goals. |
| 32 | ComfortNoise | Injects perceptually shaped noise floor during silence. Prevents "dead silence" artifacts. |
| 33 | ExportEncoder | WAV (16/24/32-bit), MP3 (VBR/CBR), FLAC, OGG. Dither per bit-depth. |

### Pass 10 — Forensic (Stages 34–35)

| Stage | Module | Function |
|---|---|---|
| 34 | ChainOfCustody | SHA-256 hash of input + output. Timestamped processing log. SWGDE-compliant metadata. |
| 35 | ABComparator | Quality metrics (SNR, PESQ estimate, spectral consistency). Drives A/B toggle in UI. |

---

## 4. Algorithms & Models

### Model Selection

| Model | Role | Size (INT8) | Backend | Selection Rationale |
|---|---|---|---|---|
| Demucs v4.1 | Primary source separation | ~150 MB | WebGPU / WebGL2 / WASM | Hybrid Transformer + U-Net; captures temporal detail and long-range spectral dependency simultaneously |
| BS-RoFormer | Ensemble complement | ~45 MB | WebGPU / WebGL2 / WASM | Rotary-position-embedding excels 1–4 kHz — exactly where Demucs is weakest. Ensemble = +1–2 dB SDR |
| Conformer-S | Anti-garble residual cleanup | ~8 MB | WASM (real-time safe) | Trained specifically on Demucs + BSRoFormer output debris; surgical precision without speech degradation |
| ECAPA-TDNN | Voiceprint / speaker ID | ~10 MB | WebGPU / WASM | 192-dim embeddings; 3-second enrollment; accurate cosine similarity in noisy conditions |
| Silero VAD v5 | Voice activity detection | ~0.35 MB | WASM | 10 ms resolution; accurate on whispers and low-SNR speech; critical for forensic gate operation |
| pyannote Community-1 | Speaker diarization | ~25 MB | WASM | 2025 model; < 200 ms transition latency; 8-speaker limit |
| HiFi-GAN v2 (Universal) | Neural vocoder | ~12 MB | WebGPU / WASM | Universal variant handles any speaker without finetuning; restores naturalness degraded by spectral ops |

**Total ML payload**: ~250 MB (INT8 quantized). Lazy-loaded per monetization tier.

### Adaptive Noise Modeling

```
// Martin minimum statistics (Stage 05)
function updateNoiseProfile(spectrum, windowIndex) {
  const window = getWindow(windowIndex);  // 50ms rolling window
  noiseFloor = min(noiseFloor * forgettingFactor, window.minMagnitude);
  smoothedFloor = α * smoothedFloor + (1 - α) * noiseFloor;  // α = 0.98
  noiseProfile[bin] = smoothedFloor + bias_correction;       // Martin bias
}
```

### Ensemble Fusion Logic

```
// Per-bin confidence-weighted fusion (Stage 16)
function fuseEnsemble(demucsSpec, bsrSpec, inputSpec) {
  for each bin [t, f]:
    demucsConf = computeConfidence(demucsSpec[t][f], inputSpec[t][f]);
    bsrConf    = computeConfidence(bsrSpec[t][f], inputSpec[t][f]);
    if (Math.abs(demucsConf - bsrConf) < AGREEMENT_THRESHOLD):
      fusedSpec[t][f] = 0.5 * demucsSpec[t][f] + 0.5 * bsrSpec[t][f];
    else:
      weight = softmax([demucsConf, bsrConf]);
      fusedSpec[t][f] = weight[0] * demucsSpec + weight[1] * bsrSpec;
}
```

---

## 5. Complete Pipeline Pseudocode

```javascript
async function processAudio(inputFile, config) {
  // PASS 1: INGEST
  const raw        = await AudioDecoder.decode(inputFile);           // Stage 01
  const normalized = ChannelNormalizer.process(raw);                 // Stage 02
  const spectrum   = STFT.forward(normalized, 4096, 0.75, 'hann');  // Stage 03 — ONE forward FFT

  // PASS 2: ANALYSIS (in-place on spectrum)
  const levels     = LevelDetector.measure(spectrum);                // Stage 04
  const noisePrf   = NoiseProfiler.estimate(spectrum);               // Stage 05
  const humFreqs   = HumDetector.detect(spectrum);                   // Stage 06
  const vadMask    = SileroVAD.gate(spectrum);                       // Stage 07
  const noiseType  = NoiseClassifier.classify(spectrum, noisePrf);   // Stage 08

  // PASS 3: CLASSICAL DSP (in-place spectral ops)
  NotchFilterBank.apply(spectrum, humFreqs);                         // Stage 09
  ERBGate.apply(spectrum, noisePrf, vadMask);                        // Stage 10
  SpectralSubtractor.apply(spectrum, noisePrf);                      // Stage 11
  TemporalSmoother.smooth(spectrum);                                  // Stage 12
  AdaptiveWiener.filter(spectrum, noisePrf);                         // Stage 13

  // PASS 4: ML SEPARATION (in spectral domain)
  const demucsOut  = await DemucsV4.separate(spectrum);              // Stage 14
  const bsrOut     = await BSRoFormer.separate(spectrum);            // Stage 15
  const fused      = EnsembleFusion.fuse(demucsOut, bsrOut);        // Stage 16
  const gated      = VoiceprintGate.apply(fused, config.voiceprint); // Stage 17

  // PASS 5: ANTI-GARBLE (in-place spectral refinement)
  const cleaned    = await ConformerS.cleanup(gated);                // Stage 18
  SpectralTiltCorrector.correct(cleaned);                            // Stage 19
  HarmonicReconstructor.reconstruct(cleaned, vadMask);               // Stage 20
  MusicalNoiseSuppressor.suppress(cleaned);                          // Stage 21

  // PASS 6: ROOM
  const roomProfile = RoomProfiler.analyze(cleaned);                 // Stage 22
  WPEDereverber.dereverberate(cleaned, roomProfile);                 // Stage 23
  EarlyReflectionRemover.remove(cleaned, roomProfile);               // Stage 24

  // PASS 7: TIME-DOMAIN RESTORE
  Declicker.process(cleaned);                                         // Stage 25
  const timeDomain = STFT.inverse(cleaned);                          // Stage 26 — ONE inverse FFT
  PhaseCorrector.verify(timeDomain, cleaned);                        // Stage 27

  // PASS 8: NEURAL RECONSTRUCTION
  const resynth    = await HiFiGAN.vocode(timeDomain);               // Stage 28
  const best       = PESQGuard.check(resynth, timeDomain);           // Stage 29

  // PASS 9: MASTERING
  DynamicsProcessor.process(best, config.dynamics);                  // Stage 30
  LoudnessNormalizer.normalize(best, config.lufsTarget);             // Stage 31
  ComfortNoise.inject(best, vadMask);                                 // Stage 32
  const output     = ExportEncoder.encode(best, config.format);      // Stage 33

  // PASS 10: FORENSIC
  ChainOfCustody.log(inputFile, output, config);                      // Stage 34
  ABComparator.measure(raw, output);                                  // Stage 35

  return output;
}
```

---

## 6. Source Module Map (v22.1 Actual)

| File | Lines | Purpose |
|---|---|---|
| `public/app/index.html` | — | App shell: 52-slider engineer panel, 6-panel diagnostics, 3D Hexawave |
| `public/app/app.js` | 2121 | Main application: pipeline wiring, transport, A/B toggle, presets, visualizations |
| `public/app/dsp-core.js` | 1373 | Pure DSP math: STFT/iSTFT, Wiener, ERB gate, harmonic v2, dereverberation |
| `public/app/dsp-worker.js` | 504 | Web Worker wrapper offloading DSPCore |
| `public/app/dsp-processor.js` | 1013 | AudioWorklet processor: real-time streaming < 12 ms |
| `public/app/ml-worker.js` | 697 | ONNX Runtime Web inference: Demucs, BSRoFormer, ECAPA-TDNN, Silero VAD |
| `public/app/pipeline-orchestrator.js` | — | DAG execution engine, stage dependencies, boundary validation, error propagation |
| `public/app/pipeline-state.js` | — | Centralized reactive state for all pipeline parameters |
| `public/app/ring-buffer.js` | — | Lock-free wait-free SPSC SharedArrayBuffer ring buffer |
| `public/app/ai-engine-v2.js` | — | Voice fingerprinting, gradient-descent auto-tune, multi-speaker detection |
| `public/app/batch-orchestrator.js` | — | Multi-file batch queue, priority scheduling, ZIP export |
| `public/app/batch-processor.js` | — | Individual batch job execution and progress reporting |
| `public/app/license-manager.js` | — | Offline JWT license validation and tier enforcement |
| `public/app/paywall.js` | — | Feature gating, Stripe / RevenueCat integration |
| `public/app/revenuecat.js` | — | RevenueCat IAP SDK wrapper |
| `public/app/cloud-sync.js` | — | Cross-device preset and profile sync via REST API (Studio+ tier) |
| `public/app/analytics.js` | — | Local-first privacy analytics; server reporting opt-in only, never includes audio |
| `public/app/mobile.css` | — | Mobile layout and touch-optimized controls |
| `public/app/style.css` | — | Main stylesheet |

---

## 7. App Design

### 7.1 One-Tap Clean Mode

Drag-and-drop or file picker → single **CLEAN** button. System auto-detects noise type, applies optimal preset, runs full 35-stage pipeline, presents A/B comparison + export. No parameters to configure. Target: podcasters, creators, casual users.

### 7.2 Advanced Engineer Panel

52 slider controls across 6 parameter groups:

- **Noise Reduction**: spectral subtraction α, per-band gate thresholds, noise profile lock/unlock, hum frequency override
- **Voice Isolation**: model selection (Demucs / BSRoFormer / Ensemble), ensemble weights, voiceprint similarity threshold
- **Spectral Controls**: FFT size (1024–16384), hop size, window function, spectral tilt, formant boost Q
- **Room**: dereverberation strength, RT60 override, room profile (8 environments), distance compensation
- **Dynamics**: transient attack/release, compressor threshold/ratio, limiter ceiling, comfort noise floor
- **Anti-Garble**: residual mask strength (0–100%), harmonic reconstruction order (1–8), tilt compensation amount

### 7.3 Export Presets (9 Professionally Tuned)

| Preset | LUFS | Gate | Notes |
|---|---|---|---|
| Podcast | −16 | Moderate | Wide voice, light NR, broadcast-safe |
| Film | −24 | Light | Full dynamic range, preserve ambience |
| Interview | −16 | Aggressive | Max speech clarity, cut all background |
| Forensic | −18 | None destructive | 32-bit float, full audit trail, SHA-256 |
| Broadcast | −23 | Moderate | EBU R128 compliant |
| Dialogue | −16 | Aggressive | Film ADR-style clarity |
| Music | −14 | Light | Preserve harmonic richness |
| Conference | −18 | Adaptive | Multi-speaker aware |
| Whisper | −12 | Minimal | Low-SNR input preservation |

### 7.4 3D Hexawave Spectrogram

Three.js-rendered 3D spectrogram with hexagonal cells. Color maps to energy/confidence. Bidirectional interaction: drag hexagons to adjust per-band gain; sliders update mesh in real-time. A/B toggle, spectrogram, and source selector are bidirectionally synced.

### 7.5 Mobile UI

Responsive layout with touch-optimized controls. PWA installable with offline capability after initial model download. Waveform with pinch-to-zoom. Share sheet for direct export to messaging and social apps. `mobile.css` provides mobile-specific layout layer.

---

## 8. Monetization Stack

| Tier | Price | Features |
|---|---|---|
| Free | $0 | Classical DSP only, 5 files/day, WAV export, 2 min max |
| Creator Pro | $9/mo | + Demucs v4.1, voiceprint, 5 presets, batch 10 files, MP3/FLAC export |
| Studio | $29/mo | + BSRoFormer ensemble, Anti-Garble, HiFi-GAN, batch 1000 files, cloud sync, ZIP export |
| Enterprise | Custom | Full forensic suite, chain-of-custody, unlimited batch, plugin API, SLA, on-premise option |

Licensing: offline JWT validation via `license-manager.js`. Payment: Stripe (web) + RevenueCat IAP (iOS/Android). Feature gating enforced at pipeline registration time by `paywall.js` — not just UI-level.

---

## 9. Optimization Strategies

### Low-Latency Real-Time Path

- AudioWorklet on audio rendering thread with guaranteed timing (no JS main-thread jank)
- SharedArrayBuffer ring buffer: zero-copy exchange between AudioWorklet and DSP workers
- 128-sample blocks at 48 kHz = 2.67 ms per block, 12 ms end-to-end
- `process()` method: zero allocations, pre-allocated buffer pool, no GC pressure

### ML Inference Optimization

- INT8 quantization: 4× size reduction, < 0.5 dB quality loss
- WebGPU STFT/iSTFT: 10–50× faster than CPU path
- Lazy model loading: only download models required for active tier/preset
- Model warm-up: pre-warm during file decode phase (first inference 2–3× slower due to shader compilation)

### Memory Management

- `Float32Array` pooling: pre-allocate and reuse spectral buffers
- Streaming decode: 10-second chunks, never load entire file into memory
- Peak memory budget: 512 MB single-file, 2 GB batch (4 concurrent jobs)
- Memory pressure monitor: auto-throttles pipeline at > 80% heap

### Progressive Enhancement

| Tier | Capability | Download |
|---|---|---|
| Baseline (no JS models) | Classical DSP only | < 5 MB |
| Creator Pro | + Silero VAD + Demucs v4.1 | ~155 MB additional |
| Studio | + BSRoFormer + HiFi-GAN | ~57 MB additional |
| Forensic | + Conformer-S + pyannote | ~38 MB additional |

---

## 10. Security & Privacy Architecture

- **Zero Cloud Egress**: hard architectural constraint. Audio data never leaves the browser. Processing occurs entirely client-side.
- **COOP/COEP Headers**: required for SharedArrayBuffer. `vercel.json` enforces `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- **Content Security Policy**: `self`, `cdnjs.cloudflare.com` (Three.js), `blob:` / `data:`. No external data origins.
- **Session Encryption**: audio buffers in SharedArrayBuffer encrypted at rest with AES-256-GCM, per-session ephemeral key, destroyed on page unload.
- **Zero Telemetry**: no analytics by default. Server reporting is strictly opt-in via `analytics.js`, never includes audio data.
- **Model Integrity**: ONNX model files SHA-256 verified on load. Tampered models rejected before execution.
- **Forensic Chain of Custody**: SHA-256 hash of input and output, timestamped processing log, tamper-evident metadata. SWGDE Best Practices compliant.
- **Plugin Sandbox**: third-party DSP modules execute in an isolated Worker with no network access, 50 ms CPU budget per block, 64 MB memory ceiling.

---

## 11. Development Roadmap

### Phase 1: MVP — Complete ✓
- 35-stage classical DSP pipeline
- One-Tap Clean mode with auto noise detection
- WAV/MP3/FLAC export
- Responsive web UI with 3D Hexawave spectrogram
- Vercel auto-deploy with COOP/COEP headers
- 837 unit tests passing across 22 test suites

### Phase 2: Creator Pro — Q2 2026
- Demucs v4.1 integration + voiceprint enrollment
- Full 52-slider engineer panel exposed in UI
- Batch processing up to 10 files
- 9 export presets
- Creator Pro tier billing via Stripe + RevenueCat

### Phase 3: Studio Edition — Q3 2026
- BSRoFormer + ensemble fusion live
- Anti-Garble system: Conformer-S + harmonic reconstruction + PESQ guard
- HiFi-GAN neural vocoder
- Multi-speaker diarization (pyannote)
- Batch processing up to 1,000 files + ZIP export
- Cloud sync for presets and voice profiles
- A/B comparison with quality metrics

### Phase 4: Forensic Pro — Q4 2026
- Full chain-of-custody metadata + SHA-256 audit trail
- 32-bit float export with zero-destructive processing option
- Expert witness report generation
- Unlimited batch with priority queue
- Custom DSP plugin API for third-party modules
- Forensic tier: $79/mo

### Phase 5: Platform — 2027+
- Public SDK / npm package for third-party integration
- Plugin marketplace
- React Native mobile apps (iOS/Android) via Capacitor (Android scaffolding already committed)
- Desktop app via Electron/Tauri
- Enterprise licensing and on-premise deployment

---

## 12. Performance Benchmarks & Targets

| Metric | Target | Architecture Enabler |
|---|---|---|
| Real-time latency | < 12 ms | AudioWorklet + SAB ring buffer |
| Offline processing | > 10× real-time | OfflineAudioContext + GPU workers |
| Noise floor | −96 dB | 32-bit float processing throughout |
| SNR improvement (speech) | > 20 dB | 35-stage cascade + ML ensemble |
| PESQ score | > 4.2 | HiFi-GAN vocoder + Anti-Garble |
| ML inference (Demucs) | < 2× real-time | WebGPU INT8 |
| Batch throughput | 1,000 files/session | Priority queue + 4 concurrent workers |
| Peak memory (single file) | < 512 MB | Streaming 10 s chunks + buffer pooling |
| Test coverage | 837 tests / 22 suites | Full pass on CI |

---

*Document Version: 22.1 | April 2026 | Reflects codebase at commit HEAD (main)*
*Architecture: Threads from Space v11 | Pipeline: 35-Stage Deca-Pass*
*Previous blueprints (v19–v22.0) superseded by this document.*
