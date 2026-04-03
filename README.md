# VoiceIsolate Pro

[![CI & Deploy](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml/badge.svg)](https://github.com/Joker5514/VoiceIsolate-Pro/actions/workflows/deploy.yml)
![Version](https://img.shields.io/badge/version-22.1.0-blue)
![License](https://img.shields.io/badge/license-All%20Rights%20Reserved-red)
![Platform](https://img.shields.io/badge/platform-browser%20%7C%20android%20%7C%20ios-lightgrey)
![Privacy](https://img.shields.io/badge/privacy-100%25%20local-brightgreen)

> **Studio-grade voice isolation and audio enhancement — 100% local, zero cloud inference. Now with improved presets, A/B toggle, and resume playback.**

VoiceIsolate Pro is a cross-platform audio processing engine powered by a **36-stage Deca-Pass DSP pipeline** that combines hybrid ML and classical spectral processing. Built on the **Threads from Space v10** architecture, every byte of audio stays on your device — no uploads, no telemetry, no exceptions.

---

## Current Version: v22.1.0

### What's New

- **Resume Playback**: Pause and resume from exactly where you left off — no restart needed.
- **Original/Processed Toggle**: Visual toggle switch in the transport bar to instantly switch between original and processed audio, synced with the spectrogram view.
- **Improved Presets**: All 9 presets (Podcast, Film, Interview, Forensic, Music, Broadcast, Restoration, Whisper, Crystal Voice) have been professionally retuned for better results out of the box.
- **Spectrogram Sync**: A/B toggle in transport, spectrogram, and source toggle are all bidirectionally synced.
- **File Uploads Fixed**: Solved strict MIME type validation bugs that previously prevented common audio/video types (like MP3s and MKVs) from uploading correctly.
- **Engineer Mode Refined**: Removed the clunky "How It Works" card from the main app interface to streamline the mobile UI and save space.
- **CI/CD Fixes**: Deploy workflow now triggers on pull requests, CSP hardened (removed `wasm-unsafe-eval`, added `cdnjs.cloudflare.com`).

### Previous: v22.0.0 — Monetization & AI Engine v2

- **Freemium Monetization System**: Free, Pro ($12/mo), Studio ($29/mo), and Enterprise tiers.
- **Paywall & Licensing**: Secure offline JWT license validation, feature gating, and Stripe/RevenueCat integration.
- **AI Engine v2**: Voice fingerprinting, advanced auto-tune via gradient descent, noise profile library, and multi-speaker detection.
- **Batch Processing**: Process multiple files concurrently with ZIP export (Studio/Enterprise feature).
- **Cloud Sync**: Sync presets, noise profiles, and history across devices (Studio/Enterprise feature).

---

## Features

| Feature | Detail |
|---------|--------|
| **36-stage Deca-Pass DSP** | 10 passes × 4 stages: Ingest → Analysis → Filter → Spectral NR → EQ → Spectral Processing → Dynamics → Master → Export |
| **9 Tuned Presets** | Podcast, Film, Interview, Forensic, Music, Broadcast, Restoration, Whisper, Crystal Voice + custom presets |
| **A/B Toggle** | Instantly switch between original and processed audio with transport + spectrogram sync |
| **Resume Playback** | Pause and resume from exact position with full state preservation |
| **AI Engine v2** | Voice fingerprinting, noise profile library, adaptive spectral masking, and PESQ-inspired quality estimation |
| **Batch Processing** | Concurrent processing queue with progress tracking and ZIP export |
| **Cloud Sync** | Cross-device synchronization of presets and profiles via REST API |
| **Mobile Native** | Runs as a native app on Android and iOS using Capacitor, with RevenueCat IAP support |
| **Hybrid ML + Classical** | Demucs v4.1, BSRNN, DeepFilterNet3 working alongside Wiener filtering and spectral subtraction |
| **100% Local Processing** | Audio never leaves your device. No server uploads. No cloud inference. |

---

## Quick Start

### Local Web Development

```bash
git clone https://github.com/Joker5514/VoiceIsolate-Pro.git
cd VoiceIsolate-Pro
npm install
npm run dev          # Serves public/ on http://localhost:3000 with CORS
```

### Mobile App Development (Capacitor)

```bash
npm install
npm run build

# Android
npx cap add android
npx cap sync android
npx cap open android   # Opens Android Studio

# iOS (macOS only)
npx cap add ios
npx cap sync ios
npx cap open ios       # Opens Xcode
```

---

## Monetization Architecture

The v22 release includes a full monetization stack:

1. **License Manager (`license-manager.js`)**: Handles offline JWT validation, tier definitions, and usage quotas.
2. **Paywall UI (`paywall.js`)**: Renders pricing cards, feature gates, and trial banners.
3. **RevenueCat (`revenuecat.js`)**: Manages native in-app purchases for iOS and Android.
4. **Backend API (`api/monetization.js`)**: Express routes for Stripe Checkout, webhooks, and license generation.

### Tiers

- **Free**: Basic noise reduction, 5-min limit, watermarked exports.
- **Pro ($12/mo)**: Full 36-stage pipeline, ML models, unlimited duration, no watermark.
- **Studio ($29/mo)**: Pro features + Batch processing, Cloud Sync, API access.
- **Enterprise ($199/mo)**: White-label, custom models, SLA.

---

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Serve `public/` on port 3000 with CORS |
| `npm run build` | Copy `public/` into `build/` directory |
| `npm run lint` | Run ESLint on core pipeline files |
| `npm test` | Run Jest test suite |
| `npm run validate` | Run custom pipeline validation script |

---

## License

Copyright © 2024–2026 VoiceIsolate Pro. All Rights Reserved.
See [LICENSE](./LICENSE) for full terms.

---

**VoiceIsolate Pro v22.1.0** · Threads from Space v10 · Privacy-First · Updated March 2026
