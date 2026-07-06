---
title: "VoiceIsolate Pro v25 — Product Specification and Commercial Rollout"
version: "v25.0"
product: "VoiceIsolate Pro"
status: "Canonical"
updated: "2026-05-12"
owner: "Conqueror Studios / Randy Jordan"
format: "Markdown"
---

# VoiceIsolate Pro v25 — Product Specification and Commercial Rollout

> This document defines the product identity, commercial structure, and go-to-market posture for VoiceIsolate Pro v25. For architecture and engineering details see the companion docs in `docs/v25/`.

---

## Product definition

- **What it is:** A browser-first, privacy-first audio cleanup platform focused on voice isolation, denoising, dereverb, intelligibility enhancement, and engineer-grade manual control.
- **Core differentiators:** 100% local processing (no uploads, no cloud), single-pass spectral integrity, 52-slider engineer panel, live AudioWorklet mode, full offline ML stack.
- **Current release scope:** Web (Vercel) — production-ready. Android/Play Store — follow-on milestone with unresolved blockers.

---

## Product promise

- Users clean difficult audio without uploading it anywhere. All processing happens in the browser.
- The experience spans one-tap cleanup for casual users through deep engineer-mode control for advanced users.
- Privacy posture is backed by code: the repo history shows removal of cloud-sync/server-stub code to align implementation with the local-only claim.

---

## Target users

| Segment | Primary needs |
|---|---|
| Creators / Podcasters | Fast cleanup, dereverb, denoise, presets, A/B, export |
| Legal / Transcription | Speaker isolation, intelligibility, local-only evidence handling |
| Film / Video | Dialogue extraction, ambience control, video file support |
| Forensic users | Aggressive extraction, audit-trail posture, maximum parameter control |
| Power users | Full 52-slider chains, presets, diagnostics, A/B tools |

---

## Tier structure

| Tier | Monthly | Annual | Key unlock |
|---|---|---|---|
| Free | $0 | — | Basic cleanup, 5 presets, 50 MB file limit |
| Creator Pro | $9.99 | — | Full 52 sliders, batch, session persistence |
| Studio | $29.99 | — | Full ML stack (Demucs, BS-RoFormer, HiFi-GAN), diarization |
| Forensic | — | $99.99 | Forensic mode, audit log, voiceprint, SHA-256 per-stage |

---

## Core features

- Voice isolation and extraction: source separation, voiceprint matching, crosstalk cancellation, VAD gating
- Cleanup: multi-band noise reduction, spectral gating, Wiener filtering, dereverb, harmonic reconstruction, de-essing, dynamics control
- Engineer surface: 52 sliders, 8 presets + custom preset save/load, session persistence, result cache
- Visualization: 3D spectrogram, oscilloscope (Wave/Mirror/Lissajous), LUFS meter, ML saliency heatmap, speaker cluster PCA
- Workflows: speaker diarization timeline, speaker isolation card, forensic mode, batch processing, A/B compare, video file support
- UI: mobile responsive, keyboard shortcuts, transport controls, UI scale control

---

## UX model

- Three tiers: One-Tap → Preset Studio → Engineer Panel
- First-run: "How It Works" onboarding page with `Don't show again` flag stored in `localStorage`
- Returning users: jump directly to Engineer Mode
- CTAs: "Start Processing" (One-Tap) and "Open Engineer Mode" (advanced)

## Landing page structure

1. Privacy-first headline
2. Proof section: before/after audio demo ("Hear the Difference")
3. Dual CTA: Start Processing / Open Engineer Mode
4. Use-case cards: Creator, Legal, Film, Forensic
5. Technical depth below the fold

---

## Commercial rollout

- **Phase 1 (now):** Web deploy to Vercel production. Browser smoke test passes. CI gated. Ship it.
- **Phase 2:** Android/native packaging — after SAB/WebView isolation, release signing, model bundling, and mobile fallback are resolved.
- **Phase 3:** Enterprise licensing, plugin formats (VST3/AU), batch CLI, white-label / source license.

---

## Success metrics

| Type | Metric |
|---|---|
| Technical | Zero NaN/Inf samples, peak in (0, 1], RMS > silence floor, partial CoV < 60% |
| Product | Conversion: landing → `/app/`, preset vs engineer mode split, export completion rate |
| Revenue | Paid upgrade rate by tier and use case |
| Trust | Explicit privacy messaging engagement, zero data-transmission audit passes |
