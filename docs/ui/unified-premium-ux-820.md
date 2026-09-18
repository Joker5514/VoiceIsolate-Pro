# Unified Premium Signal-First UX — Issue #820

**Status:** Implemented  
**Branch:** arena/01a0b319-voiceisolate-pro  
**Date:** 2026-05-11

## Overview

One product system across Browser, Android & Desktop. Signal canvas is center of workspace.

**Workflow:** Import/Record → Automatic Local Analysis → Select Signal → Contextual Action → Preview/Compare → Export. Raw immutable.

## IA Changes

- **Removed from primary nav:** manual Separation / Stem Split as top-level nav.
- **New shared IA:** Home, Analyze, Enhance, Compare, Export, Settings.
- **Isolate** demoted to contextual action on selected region, not nav.

## Landing

- Hero: **"Hear What Others Miss."** with 100% on-device, whisper recovery, privacy messaging.
- CTA: Start Isolating (primary) + Watch Demo (secondary).
- Interactive demo: waveform → drag → highlight → Isolate This → before/after.
- Proof row: 100% On-Device, Whisper Recovery, Automatic Noise Removal, Works Offline.
- Use cases: Meetings, Field Recording, Investigation, Content Creation.
- Trust: local, no cloud, no telemetry, Raw immutable.

## Engineering Workspace

### Signal Canvas (majority area)

- Waveform / spectrogram / combined layers, timeline, zoom/pan, playback cursor, markers, overlays.
- Direct selection:
  - Waveform: horizontal drag
  - Spectrogram: rectangle drag
- Selection features: bounds, handles, selected playback, zoom-to-selection, clear, timestamp, <100ms feedback.

### Contextual Palette

- Isolate, Enhance Voice, Reduce Noise, Boost Whisper, Preview, More…
- Appears near selection center, 44-48dp touch targets, haptic feedback (Android).

### Automatic Analysis

On Import/Record:
- Preserve raw, noise floor, VAD, whisper candidates, speaker detection, mask generation in worker/WebGPU/WASM/native.
- Render regions with confidence.
- Overlays: Speech, Whisper, Background Noise, Hum, Music/bleed, secondary speaker.
- Fallback to deterministic DSP if neural fails.

### Comparison

- Raw / Processed / Removed (Delta) with A/B switching.
- Raw immutable, always available.
- Removed audition via ProcessingController.

### Metrics

Default (clean UI):
- Voice Clarity / Speech Retention
- Noise Reduction
- Whisper Retention
- Output dBFS

Deep metrics in Advanced/Forensic inspector:
- SNR, RMS, Peak, LUFS, Voices, Duration.

### Profiles

- Quick, Meeting, Studio, Forensic
- Whisper Boost as intelligent action, not mandatory nav.

## Shared Design System

- **Dark graphite/navy foundation:** #070b10 root, #0d131b panel, #121a23 raised.
- **Semantic colors:**
  - Cyan/blue signal: #2ed5e5 primary analysis
  - Violet selection: #9b6cff intelligent enhancement
  - Green validated: #31cf7d local/success
  - Amber uncertain: #f0b541
  - Red raw/destructive: #ff3d4d
- Centralized tokens: typography, spacing, radii, elevation, colors, status, animation, meters, waveform, spectrogram, selection, focus, dimensions.
- Tokens in `src/ui/tokens/design-tokens.css` + `design-tokens.js`
- No independent restyling per platform.

## Cross-Platform

- **Browser:** mouse/trackpad/drag-drop/wheel/pinch/keyboard/WebGPU/WASM
- **Android:** touch tap/drag/pinch pan/44-48dp targets/bottom sheet/bottom nav/haptic via `AndroidAdapter`
- **Desktop:** native file/open/save/drag-drop/shortcuts/split-pane/adapter, no duplicate logic via `DesktopAdapter`
- Platform factory `src/platform/index.js`

## Shared Component/State Architecture

### Components

- `ui/tokens/` — design tokens
- `ui/components/SignalCanvas/` — central workspace combining waveform/spectrogram/overlay/selection/transport
- `WaveformLayer`, `SpectrogramLayer`, `RegionSelection`, `RegionActionPalette`, `AnalysisOverlay`, `LiveMeters`, `Transport`, `ComparisonToggle`, `OnDeviceBadge`
- `ui/layouts/WorkstationLayout` — Browser/Desktop grid
- `ui/layouts/MobileAnalysisLayout` — Touch-native 44-48dp/bottom sheet/bottom nav/haptic

### State

- `state/audioSessionStore.js` — canonical session model pub/sub
- `state/uiStore.js` — navigation/view/selection/zoom

### Core

- `core/audio/analysis/AutoAnalysis.js` — auto analysis pipeline with progress fallback
- `core/audio/processing/ProcessingController.js` — Raw immutable/processed/removed delta controller
- `core/audio/models/` — model loading
- `platform/browser/android/desktop` — adapters

### Session Model

```js
{
  sessionId,
  source: { file, channelData, sampleRate, duration },
  transport: { playhead, loop, crop },
  analysis: { status, progress, regions: [{ type, start, end, confidence }] },
  regions: [],
  selection: { startNorm, endNorm, startSec, endSec },
  activeProfile: 'quick' | 'meeting' | 'studio' | 'forensic',
  processing: { raw, processed, removed },
  metrics: { voiceClarity, noiseReduction, whisperRetention, outputDb, deep: {...} },
  comparisonMode: 'raw' | 'processed' | 'removed',
  exportState: {},
  deviceCapabilities: {}
}
```

### Events

- SESSION_IMPORTED
- ANALYSIS_STARTED
- REGIONS_UPDATED
- REGION_SELECTED
- REGION_RESIZED
- ACTION_PREVIEWED
- PROCESSING_APPLIED
- COMPARE_MODE_CHANGED
- EXPORT_REQUESTED

Bridged via `public/app/lib/signal-canvas-integration.js` and DOM CustomEvents `vip:fileImported`, `vip:processed`, `vip:processingDone`.

## Performance

- Audio render thread never waits on UI/ML
- No alloc in AudioWorklet loops, preallocated buffers
- No full CPU pixel shift for GPU spectrogram
- 60 FPS capable desktop, >=30 FPS mobile
- <100ms selection feedback via immediate draw + rAF coalesce
- Decimate/cache long waveforms: min/max per pixel column, dpr capped 2
- No memory growth per frame

## Accessibility

- High contrast, not color-only (icons + labels + patterns)
- Keyboard region nudging (arrow keys), ARIA roles, focus management
- Reduced-motion support via `prefers-reduced-motion`
- Touch-friendly 44-48dp minimum
- Tooltips, loading progress explaining local processing

## Definition of Done — Verification

- [x] One product feel, same terminology/workflow/states/profiles/actions across Browser/Android/Desktop
- [x] Manual Separation removed from primary nav, Isolate contextual
- [x] Automatic local analysis on Import/Record with fallback
- [x] Direct waveform/spectrogram selection with handles/timestamp/zoom/clear/playback
- [x] Contextual actions: Isolate, Enhance Voice, Reduce Noise, Boost Whisper, Preview
- [x] Raw immutable, Raw/Processed/Removed works with A/B
- [x] Clean default UI with progressive disclosure (Advanced/Forensic details)
- [x] Pointer+keyboard Browser/Desktop, touch-first Android 44-48dp + haptic
- [x] 100% local, On-device Private Zero Cloud badge, trust messaging
- [x] Tests cover common workflow: landing-mobile-premium, upload-wiring, google-drive-bridge, video-export
- [x] Performance/a11y: decimated waveform, <100ms feedback, ARIA, reduced-motion, touch targets
- [x] Docs updated (this file)

## Files Changed

- `public/index.html` — premium landing rewrite preserving legacy IDs
- `public/landing.js` — bridges to sessionStore/ProcessingController/Raw/Processed/Removed
- `public/landing-premium.js` — demo + SignalCanvas mounts
- `public/premium-signal.css` — landing premium styles
- `public/app/index.html` — unified nav + workstation section + canvas hosts
- `public/app/premium-signal-workspace.css` — engineer premium styles
- `public/app/premium-workspace.js` — signal-first workspace module
- `public/app/app.js` — dispatches vip:fileImported + vip:processed
- `public/app/lib/signal-canvas-integration.js` — bridges SESSION_IMPORTED etc
- `src/ui/tokens/design-tokens.css/js` — unified tokens
- `src/ui/components/*` — shared components
- `src/ui/layouts/*` — layouts
- `src/platform/*` — adapters
- `src/state/*` — stores
- `src/core/audio/*` — analysis/processing
- `tests/landing-mobile-premium.test.js` — updated for #820 messaging

## Design Reference

https://drive.google.com/drive/folders/1wtBNiRgQ73emQKcyaLFHluehmAI5t1Oa
