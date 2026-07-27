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
| [releases/VoiceIsolate_Pro_v24_Latest.pdf](releases/VoiceIsolate_Pro_v24_Latest.pdf) | **Latest release notes PDF** (product + architecture snapshot) |
| [guides/WORKLETS.md](guides/WORKLETS.md) | AudioWorklet packaging (web, Android, desktop) |
| [guides/MODEL_DELIVERY.md](guides/MODEL_DELIVERY.md) | ONNX delivery, integrity, offline packaging |
| [guides/electron-desktop.md](guides/electron-desktop.md) | Electron shell, offline installer, IPC |
| [guides/ANDROID.md](guides/ANDROID.md) | Capacitor Android build, sideload, WebView notes |
| [guides/REVENUECAT_ISOLATION.md](guides/REVENUECAT_ISOLATION.md) | IAP boundary — never leak into DSP |
| [DOWNLOADS.md](DOWNLOADS.md) | Canonical GitHub Release download URLs |

---

## Decisions & audits

| Document | Description |
|----------|-------------|
| [adr/001-firebase-exception.md](adr/001-firebase-exception.md) | Sole cloud exception (auth/billing UI, not audio) |
| [audits/README.md](audits/README.md) | Point-in-time audit index |
| [audits/AUDIT-REPORT-2026-06-21.md](audits/AUDIT-REPORT-2026-06-21.md) | **Latest** comprehensive audit |
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
