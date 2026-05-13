# VOICEISOLATE PRO — Mobile Quick Reference

> v24.0.0 · AI Contributor Guide (compact)

---

## What Is This?

Browser-based, 100% local audio processing. Zero cloud. All DSP runs on-device via Web Audio API + ONNX Runtime Web. Cross-platform: Web (Vercel) + native Android/iOS via Capacitor 8.

---

## Key Numbers

| Metric | Value |
|--------|-------|
| Pipeline stages | 32 (Deca-Pass, 10 passes) |
| Sliders | 52 across 8 tabs |
| Presets | 8 named presets |
| Test suites | 62 Jest suites |
| CI workflows | 6 |
| App version | 24.0.0 |

---

## Essential Commands

```bash
pnpm install        # Setup
pnpm dev            # http://localhost:3000
pnpm test           # All 62 suites
pnpm lint           # ESLint
pnpm validate       # Structural checks
pnpm build          # public/ → build/
```

**Mobile builds:**

```bash
pnpm android:build  # Debug APK
pnpm android:bundle # Google Play AAB
pnpm ios:sync       # Sync → Xcode
```

---

## Architecture Rules (Never Break These)

**1. One STFT per path**

```text
Time → STFT(S10) → Spectral Ops(S11-S19) → iSTFT(S20) → Time
```

No second STFT/iSTFT pair anywhere.

**2. AudioWorklet** — only `pipeline-orchestrator.js` calls `addModule()`

**3. ML Worker** — only `pipeline-orchestrator.js` spawns it

**4. No CDN libraries** — ORT from `/lib/ort.min.js`, Three.js from `/lib/three.module.min.js`

**5. No audio upload** — all processing stays in the browser

**6. COOP/COEP headers** — required in `server.js`, `vercel.json`, and `sw.js`

**7. Data structures** — `STAGES` and `SLIDER_REGISTRY` live in `slider-map.js` only

---

## 32-Stage Pipeline at a Glance

| Pass | Stages | What |
|------|--------|------|
| 1 | S01–S04 | Input decode, DC remove, normalize |
| 2 | S05–S09 | VAD, gate, click/hum/de-ess |
| 3 | S10 | **Forward STFT** |
| 4–5 | S11–S19 | Wiener NR, spectral ops, dereverb |
| 6 | S20 | **Inverse STFT** |
| 7 | S21–S25 | EQ, compressor, limiter |
| 8 | S26–S28 | Render, dry/wet mix |
| 9 | S29–S31 | Normalize, metrics, waveform |
| 10 | S32 | Export + SHA-256 forensic hash |

---

## 52 Sliders (8 Tabs)

| Tab | Count | Controls |
|-----|-------|----------|
| `gate` | 6 | Threshold, range, attack/release/hold, lookahead |
| `nr` | 5 | NR amount/sensitivity/floor/smoothing |
| `eq` | 10 | 10-band parametric EQ |
| `dyn` | 8 | Compressor + brickwall limiter |
| `spec` | 8 | HP/LP, de-esser, formant shift |
| `adv` | 6 | Dereverb, stereo width, phase correction |
| `sep` | 5 | Voice isolation, background suppress |
| `out` | 4 | Output gain, dry/wet, dither |

**Adding a slider:** update `SLIDERS` in `app.js` + `SLIDER_REGISTRY` in `slider-map.js` + every preset in `PRESETS`.

---

## 8 Presets

`Voice Clarity` · `Podcast Clean` · `Forensic Extract` · `Music Vocal` · `Whisper Boost` · `Phone/Radio` · `Live Performance` · `Surveillance`

Every preset must define all 52 slider IDs — `tests/presets.test.js` enforces this.

---

## ML Models

| Model | Size | Delivery |
|-------|------|----------|
| Silero VAD (fp32) | 2.2MB | committed |
| Silero VAD (int8) | 2.3MB | committed |
| RNNoise | 1.8MB | committed |
| BSRNN Vocals | 4.3MB | committed |
| Demucs v4 | large | Vercel Blob (first-use) |
| VoiceFixer | — | Vercel Blob (first-use) |
| HiFi-GAN | — | Vercel Blob (first-use) |

Registry: `public/app/models/models-manifest.json`

---

## Key Files

| File | Purpose |
|------|---------|
| `public/app/app.js` | Main orchestrator |
| `public/app/slider-map.js` | STAGES + SLIDER_REGISTRY |
| `public/app/dsp-core.js` | Pure DSP math |
| `public/app/dsp-stages.js` | 32 stage operators |
| `public/app/pipeline-orchestrator.js` | Pipeline runner (owns worklet + ML worker) |
| `public/app/pipeline-state.js` | State + event bus |
| `public/app/ml-worker.js` | ONNX inference |
| `public/app/fft-bridge.js` | Offline STFT utility |
| `public/app/sw.js` | Service worker (COOP/COEP + cache) |
| `public/app/vip-slider-patch.js` | Slider patch (loads LAST) |
| `public/app/debug-audit.js` | `window.VIP_runAudit()` in DevTools |
| `server.js` | Local dev server |

---

## Top Pitfalls

- No CDN for ORT or Three.js — local files only
- No second STFT/iSTFT in any processing path
- ML worker and AudioWorklet owned by `pipeline-orchestrator.js` only
- `vip-slider-patch.js` loads **last** in `index.html`
- `importmap` script tag must come before any `type="module"` tag
- Tests: CommonJS (`require`). Frontend: ESM (`import`). Don't mix.
- `public/lib/` IS committed — don't gitignore it
- `build/` is gitignored — don't commit it
- Node.js 24.x required (enforced by `.npmrc`)
- Use `pnpm` only — npm/yarn not supported

---

## Mobile Platform (Capacitor 8)

**App ID:** `com.voiceisolatepro.app`  
**Supports:** Android API 23+ · iOS 14.1+

```bash
pnpm mobile:sync-version  # Sync version to manifests
pnpm android:build        # Debug APK
pnpm android:release      # Release APK
pnpm android:bundle       # AAB for Play Store
pnpm ios:sync             # Sync web assets
pnpm ios:build            # Open Xcode
```

Styles: `public/app/mobile.css` overrides the desktop theme.  
Tests: `tests/mobile-ui.test.js`, `tests/android-config.test.js`, `tests/ios-config.test.js`

---

## Deployment Quick Reference

| Platform | Command / Trigger |
|----------|-------------------|
| Vercel (primary) | push to `main` |
| Render.com | static serve from `public/` |
| Docker | `docker compose up` |
| Android | `pnpm android:bundle` |
| iOS | `pnpm ios:build` → Xcode |

---

## Environment Variables (optional for basic testing)

```bash
STRIPE_SECRET_KEY=sk_test_...
LICENSE_JWT_SECRET=your-secret-key-min-32-chars
PORT=3000
NODE_ENV=development
```

Full list: see `.env.example`
