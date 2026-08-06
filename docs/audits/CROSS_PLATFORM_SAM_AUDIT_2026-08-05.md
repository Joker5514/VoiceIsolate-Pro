# Cross-Platform Audit + SAM-Audio Decision  
**Date:** 2026-08-05  
**Base:** `main` @ `0e1e0b5` (includes PR #736 STFT/COLA work)

## 1. Architecture summary

| Layer | Location | Shared? | Role |
|-------|----------|---------|------|
| Renderer / DSP / ML | `public/app/*`, `src/core/*`, `src/pipeline/*` | **Yes** — single web core | Upload-only isolation, STFT, ONNX, USM, Live-Mix |
| Android shell | Capacitor `android/` + `capacitor.config.json` (`webDir: build`) | Shell only | Loads shared web assets; native lifecycle/permissions |
| Desktop shell | `electron/main.cjs`, `preload.cjs`, `ipc-channels.cjs` | Shell only | Secure IPC, file pick/save, model cache, auto-update |
| STFT contracts | `src/core/stft-math.js`, `stft-budget.js` | Yes | Periodic Hann, 75% Engineer hop, owner budget |

**Canonical processing core:** web renderer. Android WebView and Electron both consume the same built assets (`build` / `vip://app`). No native DSP duplicate on Android.

## 2. Web / PWA (current)

| Item | Status |
|------|--------|
| Shared renderer | Current (v25.0.0) |
| STFT single-pass + COLA | Present post-#736 |
| ONNX Runtime Web | `1.25.1` WebGPU → WASM |
| Models shipped | BSRNN, RNNoise, Silero VAD (Demucs optional/not shipped) |
| Prompted Isolation | Mode registered → USM `query` priors (classical) |
| Live mic | **Disabled** by design |
| Cloud audio upload | Not found in processing path; analytics localStorage-only |
| SAM-Audio browser ONNX | **Not present** — no verified export in repo |

## 3. Android (current)

| Item | Status |
|------|--------|
| Capacitor | `@capacitor/*` ^8.3.1 |
| minSdk | variables.gradle 23; **app/build.gradle forces 26** |
| compile/targetSdk | **35** |
| versionCode/Name | 250000 / 25.0.0 |
| WebView | Capacitor loads `build/` shared renderer |
| Permissions | INTERNET, RECORD_AUDIO (optional feature), READ_MEDIA_AUDIO, FGS media |
| Cleartext | Disabled |
| WebGPU | **Not assumed** — WebView support is incomplete/unreliable |
| SAM on-device | **Not supportable as production claim** without device matrix + model export |

## 4. Desktop Electron (current)

| Item | Status |
|------|--------|
| Electron | ^39.8.5 |
| electron-builder | ^25.1.8 |
| Security | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` |
| Preload | Whitelisted `window.vipDesktop` only |
| Models | Seeds offline models from bundle to userData cache |
| GPU detection | Not yet first-class for SAM |
| Packaging | Windows script present; mac notarize hook optional |

## 5. Dependency / version drift

| Component | Current | Action this PR |
|-----------|---------|----------------|
| Node | >=22 | Document / CI already 22 |
| pnpm | 11.3.0 | Keep |
| Capacitor 8.3 | Keep | Compatible; no forced major bump |
| Electron 39 | Keep | Security posture OK; no blind upgrade |
| ORT Web 1.25.1 | Keep | Audio path sensitive |
| AGP/Kotlin | Capacitor-managed | No drive-by AGP upgrade |

**Rationale:** Mass upgrades risk breaking Web Audio / ORT / WebView without device lab. This PR freezes stack, adds SAM as **local worker**, and extends CI/docs.

## 6. SAM-Audio decision — **OPTION B**

### Why not Option A (browser ONNX)
- No `sam-audio*.onnx` in `public/app/models/`
- Meta SAM-Audio is documented as **gated PyTorch/CUDA** (`facebook/sam-audio-*`)
- Redistribution of weights not verified
- Claiming browser SAM without a verified export would violate architecture rule #6

### Option B — Local / self-hosted worker
- `services/sam-audio/` Python worker (localhost only)
- Default `SAM_AUDIO_MODE=disabled`
- Desktop Electron may start/stop worker via main-process IPC
- Web/PWA may **opt-in** to `http://127.0.0.1:<port>` only
- Android: capability = **unavailable** unless user configures private worker; no fake on-device SAM
- Live / AudioWorklet: **never** runs SAM
- Existing BSRNN/RNNoise/USM path remains default offline isolation

## 7. Files to add / change (implementation plan)

**Add**
- `docs/audits/CROSS_PLATFORM_SAM_AUDIT_2026-08-05.md` (this file)
- `docs/guides/SAM_AUDIO.md`
- `src/core/providers/*` provider abstraction
- `services/sam-audio/*` local worker
- `electron` IPC for worker lifecycle
- tests + static cloud-audio check
- CI job for SAM static checks / Electron config validation

**Change**
- IsolationModeSelector prompted path → provider selection
- DesktopBridge + preload + main
- README platform matrix
- package.json scripts
- check scripts for no fal/replicate/cloud audio

## 8. Blockers / known limitations

1. Real Meta SAM weights require HF auth + CUDA for production quality.
2. Worker ships with **deterministic mock separator** when `sam_audio` package is not installed (CI/dev).
3. Android will **not** claim on-device SAM.
4. Browser will **not** claim WebGPU SAM.
5. Full Android release bundle / Electron multi-OS packaging requires CI runners (Linux Electron dir build validated in CI where possible).

## 9. Privacy invariant

- No fal.ai / Replicate / hosted SAM.
- No audio to Firebase/Vercel as processing path.
- Worker binds `127.0.0.1` only.
- HF tokens stay in main/worker env — never in renderer bundles.
