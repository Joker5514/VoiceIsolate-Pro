# VoiceIsolate Pro — Documentation

Single map of product, architecture, platform, and historical docs.

**Contributor contract (source of truth for code):** [`../CLAUDE.md`](../CLAUDE.md)  
**How to contribute:** [`../CONTRIBUTING.md`](../CONTRIBUTING.md)  
**User-facing product summary:** [`../README.md`](../README.md)

---

## Start here

| If you need… | Read |
|--------------|------|
| Architecture rules while coding | [`CLAUDE.md`](../CLAUDE.md) |
| Setup + PR workflow | [`CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Current system shape | [architecture/VoiceIsolate_Pro_Architecture_v26.md](architecture/VoiceIsolate_Pro_Architecture_v26.md) |
| Product / cross-platform plan | [architecture/VoiceIsolate-Pro_Master_Blueprint_v2.1.md](architecture/VoiceIsolate-Pro_Master_Blueprint_v2.1.md) |
| Download APK / Windows installer | [DOWNLOADS.md](DOWNLOADS.md) · [download page](https://voice-isolate-pro.vercel.app/download/) |
| Android sideload / offline APK | [guides/ANDROID.md](guides/ANDROID.md) |

---

## Architecture (current)

| Document | Description |
|----------|-------------|
| [architecture/VoiceIsolate_Pro_Architecture_v26.md](architecture/VoiceIsolate_Pro_Architecture_v26.md) | Unified architecture — current vs target, contracts, gaps |
| [architecture/VoiceIsolate_Pro_Technical_Whitepaper.md](architecture/VoiceIsolate_Pro_Technical_Whitepaper.md) | Single-pass spectral, ORT, live-mix vs offline |
| [architecture/VoiceIsolate-Pro_Master_Blueprint_v2.1.md](architecture/VoiceIsolate-Pro_Master_Blueprint_v2.1.md) | Product blueprint (web · desktop · Android) |

---

## Guides (how-to)

| Document | Description |
|----------|-------------|
| [guides/ANALYSIS_WORKSPACE.md](guides/ANALYSIS_WORKSPACE.md) | Full-audio analysis, Analyzer↔WhisperHunter joint map, deferred decode |
| [releases/VoiceIsolate_Pro_v25_Current_State.pdf](releases/VoiceIsolate_Pro_v25_Current_State.pdf) | **Latest product snapshot PDF** (v25.0.0 current state) |
| [releases/VoiceIsolate_Pro_v24_Latest.pdf](releases/VoiceIsolate_Pro_v24_Latest.pdf) | Prior v24 release notes PDF |
| [guides/WORKLETS.md](guides/WORKLETS.md) | AudioWorklet packaging (web, Android, desktop) |
| [guides/MODEL_DELIVERY.md](guides/MODEL_DELIVERY.md) | ONNX delivery, integrity, offline packaging |
| [guides/electron-desktop.md](guides/electron-desktop.md) | Electron shell, offline installer, IPC |
| [guides/ANDROID.md](guides/ANDROID.md) | Capacitor Android build, sideload, WebView notes |
| [guides/REVENUECAT_ISOLATION.md](guides/REVENUECAT_ISOLATION.md) | IAP boundary — never leak into DSP |
| [guides/SAM_AUDIO.md](guides/SAM_AUDIO.md) | SAM-**Audio** (sound separation) — Desktop worker / optional ONNX |
| [SAM3_TECHNICAL_DOCUMENTATION.md](SAM3_TECHNICAL_DOCUMENTATION.md) | SAM **3** (vision/video) — sidecar brief, flags, `src/sam3_integration/` status |
| [DOWNLOADS.md](DOWNLOADS.md) | Canonical GitHub Release download URLs |
| [audits/CI-FIX-PENDING-WORKFLOW-SCOPE.md](audits/CI-FIX-PENDING-WORKFLOW-SCOPE.md) · `pnpm ci:apply-patches` | Apply deploy/Android workflow patches (needs OAuth `workflow` scope) |

---

## Decisions & audits

| Document | Description |
|----------|-------------|
| [adr/001-firebase-exception.md](adr/001-firebase-exception.md) | Sole cloud exception (auth/billing UI, not audio) |
| [audits/README.md](audits/README.md) | Point-in-time audit index |
| [audits/REMEDIATION-CLICKS-AUDIT-2026-08-12.md](audits/REMEDIATION-CLICKS-AUDIT-2026-08-12.md) | Click/pop remediation + Clear Local Data + target-speaker honesty |
| [PRODUCTION_PIPELINE.md](PRODUCTION_PIPELINE.md) | Shipping ML fused single-STFT path vs experimental DSP |
| [audits/AUDIT-REPORT-2026-06-21.md](audits/AUDIT-REPORT-2026-06-21.md) | Comprehensive audit (historical) |
| [audits/AUDIT-REPORT-2026-05-30.md](audits/AUDIT-REPORT-2026-05-30.md) | Superseded baseline |

---

## Archive (historical only)

Superseded specs and one-off fix notes: **[archive/README.md](archive/README.md)**.

Do not treat archive docs as implementation truth for `main`.

---

## Public site docs (served under `/docs/`)

| Path | Notes |
|------|-------|
| [`public/docs/TECHNICAL_GUIDE.md`](../public/docs/TECHNICAL_GUIDE.md) | HTML-facing technical guide |
| [`public/docs/claude-guide.html`](../public/docs/claude-guide.html) | Contributor guide (static HTML) |
| [`public/blueprint/`](../public/blueprint/) | Lightweight blueprint landing |

---

## Layout

```
docs/
  README.md                 ← you are here
  DOWNLOADS.md
  architecture/             current design + blueprint
  guides/                   platform & feature how-tos
  adr/                      architecture decision records
  audits/                   dated audit reports
  archive/                  historical / superseded material
```

| [guides/SAM_AUDIO.md](guides/SAM_AUDIO.md) | SAM-Audio Option B local worker |
| [guides/PLATFORM_CAPABILITY_MATRIX.md](guides/PLATFORM_CAPABILITY_MATRIX.md) | Web / Android / Desktop matrix |
| [audits/CROSS_PLATFORM_SAM_AUDIT_2026-08-05.md](audits/CROSS_PLATFORM_SAM_AUDIT_2026-08-05.md) | Full audit |

