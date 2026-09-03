# VoiceIsolate Pro — Documentation

This index separates **current implementation/release truth** from historical audits and archived design material.

- **Contributor source of truth:** [`../CLAUDE.md`](../CLAUDE.md)
- **User/product overview:** [`../README.md`](../README.md)
- **Contributor workflow:** [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
- **Current download truth:** [`DOWNLOADS.md`](DOWNLOADS.md)
- **Machine-readable release evidence:** [`releases/release-provenance.json`](releases/release-provenance.json)

> Dated audits, old PDFs, `LEGACY.md`, and `docs/archive/` are point-in-time records. Do not rewrite them to look current; do not treat them as implementation truth for `main`.

## Start here

| Need | Document |
|---|---|
| Architecture rules while coding | [`../CLAUDE.md`](../CLAUDE.md) |
| Setup / testing / PR workflow | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| Current architecture overview | [`architecture/VoiceIsolate_Pro_Architecture_v26.md`](architecture/VoiceIsolate_Pro_Architecture_v26.md) |
| Cross-platform product blueprint | [`architecture/VoiceIsolate-Pro_Master_Blueprint_v2.1.md`](architecture/VoiceIsolate-Pro_Master_Blueprint_v2.1.md) |
| Product strategy | [`product/PRODUCT_STRATEGY.md`](product/PRODUCT_STRATEGY.md) |
| Current downloads and checksums | [`DOWNLOADS.md`](DOWNLOADS.md) |
| Published-vs-source platform state | [`releases/PLATFORM_SYNC.md`](releases/PLATFORM_SYNC.md) |
| Android | [`guides/ANDROID.md`](guides/ANDROID.md) |
| Windows / Electron | [`guides/electron-desktop.md`](guides/electron-desktop.md) |

## Current architecture and product docs

| Document | Purpose |
|---|---|
| [`architecture/VoiceIsolate_Pro_Architecture_v26.md`](architecture/VoiceIsolate_Pro_Architecture_v26.md) | Current/target architecture contracts and gaps |
| [`architecture/VoiceIsolate_Pro_Technical_Whitepaper.md`](architecture/VoiceIsolate_Pro_Technical_Whitepaper.md) | Technical architecture background |
| [`architecture/VoiceIsolate-Pro_Master_Blueprint_v2.1.md`](architecture/VoiceIsolate-Pro_Master_Blueprint_v2.1.md) | Web + Electron + Android mandate; iOS deferred from v1.0 scope |
| [`PRODUCTION_PIPELINE.md`](PRODUCTION_PIPELINE.md) | Shipping processing path and Engineer Console integration |
| [`product/PRODUCT_STRATEGY.md`](product/PRODUCT_STRATEGY.md) | Product definition, roadmap, risks, and release gates |

## Current guides

| Document | Purpose |
|---|---|
| [`guides/ANALYSIS_WORKSPACE.md`](guides/ANALYSIS_WORKSPACE.md) | Full-audio analysis workspace |
| [`guides/PROCESS_PROGRESS.md`](guides/PROCESS_PROGRESS.md) | Processing progress/cancellation contract |
| [`guides/WORKLETS.md`](guides/WORKLETS.md) | AudioWorklet packaging across shipped surfaces |
| [`guides/MODEL_DELIVERY.md`](guides/MODEL_DELIVERY.md) | Model delivery/integrity/offline packaging |
| [`guides/DSP_SLIDERS.md`](guides/DSP_SLIDERS.md) | Engineer control registry and interaction rules |
| [`guides/ANDROID.md`](guides/ANDROID.md) | Android build, security, sideload, troubleshooting |
| [`guides/electron-desktop.md`](guides/electron-desktop.md) | Electron shell, packaging, IPC, release guidance |
| [`guides/GOOGLE_DRIVE.md`](guides/GOOGLE_DRIVE.md) | Optional user-initiated Drive file I/O |
| [`guides/REVENUECAT_ISOLATION.md`](guides/REVENUECAT_ISOLATION.md) | Billing boundary; never part of DSP |
| [`guides/SAM_AUDIO.md`](guides/SAM_AUDIO.md) | Optional SAM-Audio integration status |
| [`guides/PLATFORM_CAPABILITY_MATRIX.md`](guides/PLATFORM_CAPABILITY_MATRIX.md) | Web / Android / Desktop capability matrix |
| [`SAM3_TECHNICAL_DOCUMENTATION.md`](SAM3_TECHNICAL_DOCUMENTATION.md) | SAM 3 vision/video sidecar status; not core voice isolation |

## Releases

| Document | Status |
|---|---|
| [`DOWNLOADS.md`](DOWNLOADS.md) | **Current canonical download URLs and observed hashes** |
| [`releases/PLATFORM_SYNC.md`](releases/PLATFORM_SYNC.md) | **Current source-vs-published artifact status** |
| [`releases/release-provenance.json`](releases/release-provenance.json) | **Machine-readable evidence** |
| [`releases/VoiceIsolate_Pro_v25_Current_State.pdf`](releases/VoiceIsolate_Pro_v25_Current_State.pdf) | Historical v25 snapshot; not authoritative over current source/provenance |
| [`releases/VoiceIsolate_Pro_v24_Latest.pdf`](releases/VoiceIsolate_Pro_v24_Latest.pdf) | Historical v24 release PDF |
| [`../CHANGELOG.md`](../CHANGELOG.md) | Release/change history |

Run `pnpm downloads:validate` to validate live release URLs and `pnpm provenance:validate` to validate provenance schema/claims.

## Decisions

| Document | Purpose |
|---|---|
| [`adr/001-firebase-exception.md`](adr/001-firebase-exception.md) | Superseded Firebase auth/billing proposal; retained as decision history |
| [`adr/002-google-drive-file-io.md`](adr/002-google-drive-file-io.md) | Optional, user-initiated Drive import/export boundary |

## Audits — historical evidence

See [`audits/README.md`](audits/README.md).

Audit reports describe the repository at their recorded date/SHA. Old failing checks, release SHAs, version numbers, and remediation notes should not be silently modernized; newer audits or current CI supersede them operationally.

## Archive

Superseded specs and one-off historical fix notes live in [`archive/`](archive/). Stub/redirect documents at the top of `docs/` may point into the current architecture folders for compatibility.

## Public static docs

| Path | Purpose |
|---|---|
| [`../public/docs/TECHNICAL_GUIDE.md`](../public/docs/TECHNICAL_GUIDE.md) | Static technical guide served with the application |
| [`../public/docs/claude-guide.html`](../public/docs/claude-guide.html) | Static contributor guide |
| [`../public/blueprint/`](../public/blueprint/) | Lightweight blueprint surface |

## Directory layout

```text
docs/
  README.md
  DOWNLOADS.md
  architecture/   current architecture + blueprint
  product/        current product strategy
  guides/         platform/feature guidance
  releases/       current evidence + historical release snapshots
  adr/            architecture decisions
  audits/         dated point-in-time audit evidence
  archive/        superseded material
```
