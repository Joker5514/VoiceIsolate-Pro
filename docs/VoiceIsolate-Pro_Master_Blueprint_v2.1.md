# VoiceIsolate-Pro: The Complete Cross-Platform Master Blueprint (v2.1 – July 2026)

**Status**: Authoritative engineering plan. Incorporates original 2026 architectural vision, current GitHub implementation (Joker5514/VoiceIsolate-Pro), Google Drive redesign inputs, and rigorous technical corrections from peer review.

**Core Mandate**: 100% local, privacy-first voice isolation and audio enhancement. Single source of truth for Web, Desktop, and Mobile development.

---

## I. Executive Vision & Product Goals

VoiceIsolate-Pro is a local-first, studio-grade voice isolation & audio enhancement platform that decomposes audio into controllable sound classes for user-driven remixing.

### Non-Negotiable Principles
- **Privacy-First**: Zero cloud inference. All processing on-device.
- **Separation Before Enhancement**: Source isolation strictly precedes any EQ, de-essing, or neural beautification.
- **Target-Speaker Focus**: Prioritize one (or N) specific voices using speaker similarity embeddings while attenuating other human speakers and noise.
- **Deterministic Spectral Backbone**: Single forward STFT + single inverse iSTFT across the entire pipeline (enforced in CLAUDE.md). No repeated phase damage.
- **Dual-Pipeline Execution**:
  - Lightweight path for sub-100 ms live monitoring.
  - Chunked, heavy-compute path for offline Creator and Forensic modes.

### 2026 Product Scope
- **Web**: Primary reference implementation + marketing vehicle (Vercel).
- **Desktop**: Downloadable native apps (Windows/macOS/Linux) with installers and auto-updates.
- **Mobile**: Production Android app (building on existing Capacitor 8 foundation). iOS support is **explicitly out of scope** for v1.0 (Capacitor iOS folder exists but will not receive active development resources until Android is stable).

**Target Users**: Podcasters, video editors, forensic analysts, musicians, accessibility developers, content creators.

---

## II. Current State (July 2026)

**Repository**: https://github.com/Joker5514/VoiceIsolate-Pro  
**Live Demo**: https://voice-isolate-pro.vercel.app

**Implemented Highlights**
- Full offline batch pipeline: decode → resample → separation (HTDemucs-style) → RNNoise → spectral cleanup → diarization (log-mel timbral fingerprinting).
- Real-time playback mixing with independent AudioBufferSourceNode / GainNode / DSP chains.
- Rich visualizations: Canvas 2D waveform/spectrum/spectrogram + Three.js 3D topo and particle swarm.
- ONNX Runtime Web (WebGPU primary + WASM fallback, up to 8 threads).
- Model caching in IndexedDB with SHA-256 verification.
- Capacitor 8 for Android (existing `android/` project; `pnpm build:mobile`).
- Strict security headers (COOP/COEP, CSP, etc.).
- 2,100+ Jest tests + CI (ESLint, Semgrep, njsscan).

**Known Gaps Addressed in v2.1**
- Ring-buffer overlap-add math now fully specified.
- Electron security model explicitly documented.
- Model storage strategy is platform-aware.
- HTDemucs feasibility clarified per platform.
- Realistic timelines.

---

## III. Architectural Foundations (Corrected & Hardened)

### Core Contracts (Enforced via CLAUDE.md)
1. **Single STFT / Single iSTFT Rule** — Non-negotiable across all platforms and modes.
2. **Deterministic DSP** — `dsp-core.js` owns global PSD tracking, ERB/Bark-band gates, and subsonic HPF (18–20 Hz).
3. **Lock-Free Ring Buffers** — `ring-buffer.js` bridges AudioWorklet 128-sample quanta to larger FFT windows using `SharedArrayBuffer`.
4. **Multiplicative Mask with Floor** (prevents total target erasure):

$$
X_{out}(t,f) = X(t,f) \cdot \max(M_{hum} \cdot M_{noise} \cdot M_{speech} \cdot M_{speaker} \cdot M_{dereverb} \cdot M_{res}, M_{floor})
$$

Typical $M_{floor} = -30$ dB.

### Thread & Data Flow Model (6 Contexts)

| Execution Context     | Primary Components                          | Key Responsibilities |
|-----------------------|---------------------------------------------|----------------------|
| Main Thread           | UI layer + visual-click-isolation.js + Three.js | Spectrogram rendering, macro controls, file I/O, visualizations |
| AudioWorklet          | dsp-core.js + ring-buffer.js               | 128-sample quantum loop, deterministic filters, data handoff to workers |
| Dispatcher Worker     | Job Scheduler                              | State coordination, offline chunking, model warmup, job queuing |
| Analysis Worker       | Environmental Estimator + Diarization      | Noise PSD, hum tracking, VAD (Silero), transient clicks, speaker fingerprinting |
| Separation Worker     | ONNX Runtime (platform-specific)           | Heavy ML masks (specialist models or full HTDemucs) via WebGPU / NNAPI / ExecuTorch |
| Encoder Worker        | AudioEncoderWorker                         | Off-main-thread WAV/MP3 export |

### Explicit Ring-Buffer Math (Added per Review)

**Constraint (added to CLAUDE.md)**: `HOP_SIZE` **must** be an integer multiple of the AudioWorklet quantum (128 samples).

```javascript
// Codified constants (ring-buffer.js and CLAUDE.md)
const QUANTUM = 128;           // AudioWorklet render quantum
const FFT_SIZE_LIVE = 1024;    // Live mode (smaller for latency)
const FFT_SIZE_CREATOR = 4096; // Creator/Forensic
const HOP_SIZE = 512;          // 75% overlap → FFT_SIZE / 4
const QUANTA_PER_HOP = HOP_SIZE / QUANTUM; // Must be integer (e.g., 4)

// Overlap-Add reconstruction logic must accumulate exactly QUANTA_PER_HOP
// quanta before triggering an FFT window. Windowing (Hann) + OLA must be
// perfectly symmetric to avoid clicks at boundaries.
```

**Live Mode Latency Clarification** (corrected):
- Target: **< 80–100 ms** end-to-end (more realistic).
- Live mode uses **smaller FFT (1024 or 512)** + RNNoise fallback.
- Creator/Forensic modes use 4096–8192 point FFTs with full ML.

### Target-Speaker Enrollment (Now Fully Specified)

**Minimum Viable Enrollment**
- 3 seconds of clean target speech at SNR > 10 dB.
- User highlights region in spectrogram UI.

**Embedding Management**
- Extraction: ECAPA-TDNN → 192-dim embedding.
- Update Strategy: Exponential Moving Average (EMA) with α = 0.05 (smooth adaptation across session).
- Storage: Session-scoped only (never persisted across app restarts unless user explicitly saves a "voice profile").

**Masking Logic**
- Cosine similarity threshold: **Configurable, default 0.75**.
- Soft mask: `similarity_mask = clamp((cos_sim - threshold) / (1 - threshold), 0, 1)`
- Multi-speaker support: Up to N enrolled embeddings. Union mask (logical OR of individual similarity masks) with per-speaker gain controls.

---

## IV. Cross-Platform Strategy (Corrected)

### Web (Reference Implementation)
- Vercel + strict COOP/COEP for `SharedArrayBuffer`.
- Primary vehicle for marketing, demos, and rapid iteration.

### Desktop
**Short-term (Recommended for fast shipping)**: **Electron**
- Reuse 85–95% of existing renderer code.
- Required security configuration (see Section VIII).
- ONNX via `onnxruntime-web` (WebGPU) or `onnxruntime-node` for native acceleration.
- Packaging: `electron-builder` with code signing and `electron-updater`.

**Long-term (Recommended for performance & size)**: **Tauri 2**
- Significantly smaller installers and lower RAM footprint.
- Rust backend option for future port of performance-critical DSP.
- Official Android support (unified path).

### Android (Primary Mobile Focus)
- Foundation: Existing Capacitor 8 project (`android/` folder).
- Enhancements:
  - Foreground Service + WorkManager for long-running separations.
  - Model strategy: Quantized specialist ONNX models or **ExecuTorch** (GPU via Vulkan / NNAPI on Android).
  - Audio: Oboe or equivalent low-latency native layer.
- **iOS**: Explicitly **out of scope** for v1.0. Capacitor iOS scaffolding exists but receives no active development.

**HTDemucs Feasibility Note** (Critical Correction)
- Full HTDemucs (hybrid Transformer-U-Net) is memory-intensive in ONNX Runtime Web.
- **Strategy**:
  - Web/Desktop: Full or large specialist models acceptable.
  - Mobile: Use **distilled / quantized specialist models** (e.g., vocals-only or 4-stem lightweight variants) or ExecuTorch exports. Validate SDR vs. size trade-off before committing.

---

## V. Model & Storage Strategy (Platform-Aware)

**Core Models**
- VAD: Silero VAD (always-on).
- Lightweight enhancement: RNNoise (Live fallback).
- Separation: HTDemucs-style or specialist ONNX/ExecuTorch models.
- Speaker: ECAPA-TDNN (192-dim embeddings).

**Storage & Caching (Corrected)**
- **Web**: IndexedDB with SHA-256 verification. Fallback to Cache API. Note: iOS Safari origin quota ~50 MB — warn users or use smaller specialist models.
- **Desktop (Electron/Tauri)**: Filesystem cache (much larger allowance). Never rely solely on IndexedDB.
- **Android**: App-specific storage or scoped storage. Support on-demand download of models.
- All models: SHA-256 pinned manifest + integrity check before first use in session.

---

## VI. UI/UX & Visualizations

**Core Components** (reuse + adapt)
- `visual-click-isolation.js` — interactive spectrogram + click-to-isolate.
- Stem-style macro mixer (Isolation Strength, Crosstalk Removal, Room Kill).
- Visualizations: Canvas 2D + Three.js (waveform, spectrum, spectrogram, 3D topo, particle swarm) — already implemented.

**Additions**
- Preset system for Engineer Mode (grouping of the 67+ controls).
- Forensic metadata viewer (full DSP decision log + alternative renders).

---

## VII. Build, Packaging & Distribution

**Commands (Corrected)**
- Web: `pnpm build`
- Mobile (Capacitor): `pnpm build:mobile`
- Tauri: `pnpm tauri build` (not `pnpm build:tauri`)
- Electron: Custom `pnpm build:electron` script wrapping `electron-builder`

**Distribution**
- Desktop: Signed installers + auto-updates.
- Android: Direct APK + Google Play (after compliance review).
- Web: Vercel with proper security headers.

---

## VIII. Security, Privacy & Electron Hardening (New Explicit Section)

### General
- COOP/COEP + strong CSP enforced on all web surfaces.
- Microphone permission requested only on explicit user action.
- Model SHA-256 verification before every session.
- No default telemetry. Optional opt-in only.

### Electron-Specific Requirements (Mandatory for Privacy-First Product)

```javascript
// main.js — REQUIRED secure configuration
const { BrowserWindow } = require('electron');
const path = require('path');

mainWindow = new BrowserWindow({
  webPreferences: {
    contextIsolation: true,      // REQUIRED
    nodeIntegration: false,      // REQUIRED
    sandbox: true,               // REQUIRED
    preload: path.join(__dirname, 'preload.js'), // Safe IPC bridge only
    // Additional hardening
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false
  }
});
```

- All IPC must go through `preload.js` (contextBridge).
- No direct `require` or Node access from renderer.
- File system access mediated via main process with user consent dialogs.

### Payment Security (Stripe)
- Existing partial integration must route all payment flows through secure main-process or server endpoints.
- Never expose Stripe keys or tokens to renderer process.

---

## IX. Development Workflow & Tooling

**Enforced Files**
- `CLAUDE.md` — now contains ring-buffer math constraints, single-STFT rule, and platform-specific model guidance.
- `CONTRIBUTING.md`, security guidelines.

**Testing**
- Expand existing 2,100+ Jest suite with platform-specific tests (Electron security, Android background processing, ring-buffer reconstruction accuracy).

---

## X. Realistic Roadmap (Corrected Timelines)

| Phase | Description | Realistic Timeline | Key Deliverables |
|-------|-------------|--------------------|------------------|
| 1 | Desktop MVP (Electron) | 3–4 weeks | Working signed installer, Live + Creator modes, secure preload IPC |
| 2 | Android Hardening | 5–6 weeks | Background processing, ExecuTorch/quantized model path, performance validation on mid-range devices |
| 3 | Tauri 2 Evaluation & Pilot | 8–12 weeks | Prototype unified desktop + Android build; decide on full migration |
| 4 | Polish, Distribution, iOS Re-evaluation | Ongoing | Presets, forensic viewer, Play Store submission, model SDR benchmarking |

**Immediate Priority**: Fully implement and test the ring-buffer overlap-add logic with the codified constants above.

---

## XI. Risk Mitigation & Open Items

**Biggest Remaining Risks (Addressed in v2.1)**
1. Ring-buffer reconstruction artifacts → Now fully specified with constants and CLAUDE.md rule.
2. Electron security model → Explicit hardened config provided.
3. HTDemucs mobile feasibility → Specialist/quantized/ExecuTorch path mandated with validation step.
4. Model storage quotas → Platform-specific strategy documented.
5. Timeline optimism → Corrected to realistic estimates.

**Open Validation Needed**
- Real-world SDR vs. latency vs. model size on Android mid-range devices.
- Tauri 2 Android stability in production (verify current state before full commitment).

---

## Appendices

### A. Ring-Buffer Specification (New — Extractable to ring-buffer.js)
See Section III for constants and overlap-add requirements.

### B. Electron Preload & Secure IPC Template
Available on request — will generate complete `preload.js` + typed IPC contracts.

### C. References
- Original 4-page PDF architectural vision.
- Google Drive “Voiceisolate possible redesign” folder (UI/UX evolution assets).
- Current GitHub implementation and live demo.
- Precedents: demucs-web, demixr-app, Stemify, ExecuTorch mobile examples, Tauri 2 documentation.

---

**This v2.1 document is now the single source of truth.** All previous versions are superseded.

**Next Actions Available Immediately**:
- Generate complete secure `preload.js` + main process template for Electron.
- Write full `ring-buffer.js` implementation matching the codified math.
- Produce Android background service + ExecuTorch integration outline.
- Convert this blueprint to polished PDF via the pdf skill.

Which artifact would you like first?
