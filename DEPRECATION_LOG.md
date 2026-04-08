# DEPRECATION LOG — VoiceIsolate Pro

**Maintained by:** Randy Jordan, Senior Audio-DSP Architect  
**Last updated:** 2026-04-08  
**Canonical specification:** `VoiceIsolate_Pro_v23_Blueprint.docx` (36-Stage Deca-Pass, Threads from Space v12)

> All files listed below are DEPRECATED. Do **not** use them for implementation decisions.  
> The single authoritative implementation reference is `VoiceIsolate_Pro_v23_Blueprint.docx`.

---

## Deprecated Files

| # | File Name | Deprecated On | Superseded By | Reason | Status |
|---|-----------|--------------|---------------|--------|--------|
| 1 | `VoiceIsolate-Pro-Complete.pdf` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | v9.0 era document; 18-stage pipeline conflicts with authoritative 36-stage Deca-Pass; FFT size spec (4096–16384pt live) violates correct live-mode constraint of FFT=512/hop=128 | **DEPRECATED** |
| 2 | `VoiceIsolate pro.pdf` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | Early draft, incomplete spec, superseded by multiple subsequent versions | **DEPRECATED** |
| 3 | `VoiceIsolate Pro .pdf` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | Pre-final, 18-stage spec, contains contradictory pipeline stage counts (Space files version, updated 2026-02-21) | **DEPRECATED** |
| 4 | `VoiceIsolate_Pro_v10_Aggressive_Blueprint.pdf` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | v10 intermediate draft; pipeline stage count and model parameters conflict with final 36-stage Deca-Pass architecture | **DEPRECATED** |
| 5 | `VoiceIsolate_Pro_v13_Blueprint` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | v13 draft, superseded by final production blueprint; contains stale parameter tables for noise gate thresholds and STFT hop sizes | **DEPRECATED** |
| 6 | `VoiceIsolate_Pro_v13_Blueprint.pdf` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | v13 draft, superseded by final production blueprint; contains stale parameter tables for noise gate thresholds and STFT hop sizes | **DEPRECATED** |
| 7 | `V14.pdf` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | v14 draft, superseded by final production blueprint; do not use for implementation reference | **DEPRECATED** |
| 8 | `VoiceIsolate_Pro_v5_Technical_Blueprint.docx` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | v5.0 document (January 2026), 12-stage pipeline; completely superseded | **DEPRECATED** |
| 9 | `Installing VoiceIsolate Pro v5.2.pdf` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | v5.2 install guide references outdated architecture; current build target is Vite 5 + React 18 + TypeScript + ONNX Runtime Web | **DEPRECATED** |
| 10 | `Installing VoiceIsolate Pro v5.2` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | v5.2 install guide references outdated architecture; current build target is Vite 5 + React 18 + TypeScript + ONNX Runtime Web | **DEPRECATED** |
| 11 | `voiceisolate-all.md` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | Consolidated master document merging ALL versions (v5 through v9); contains contradictory pipeline specs from multiple eras; useful for historical reference ONLY | **DEPRECATED** |
| 12 | `VoiceIsolate-Pro.md` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | Consolidated master document merging ALL versions (v5 through v9); contains contradictory pipeline specs from multiple eras; useful for historical reference ONLY | **DEPRECATED** |
| 13 | `voiceisolate-pdf.pdf` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | v9.0 overview document, 18-stage spec; superseded | **DEPRECATED** |
| 14 | `VoiceIsolate-Pro-Complete-Overview.pdf` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | v9.0 overview document, 18-stage spec; superseded | **DEPRECATED** |
| 15 | `VoiceIsolate-Pro-Complete-Overview.md` | 2026-04-08 | `VoiceIsolate_Pro_v23_Blueprint.docx` | v9.0 overview document, 18-stage spec; superseded | **DEPRECATED** |

---

## Deprecation Notice Files Created (In This Repository)

Since several deprecated files are binary (PDF/DOCX) or do not exist within the git repository, the following deprecation notice files have been created as companions or stubs:

| Deprecated File | Notice/Stub File Created |
|----------------|--------------------------|
| `VoiceIsolate-Pro-Complete.pdf` | `VoiceIsolate-Pro-Complete.DEPRECATED.md` |
| `VoiceIsolate pro.pdf` | `VoiceIsolate-pro.DEPRECATED.md` |
| `VoiceIsolate Pro .pdf` | `VoiceIsolate-Pro-space.DEPRECATED.md` |
| `VoiceIsolate_Pro_v10_Aggressive_Blueprint.pdf` | `VoiceIsolate_Pro_v10_Aggressive_Blueprint.DEPRECATED.md` |
| `VoiceIsolate_Pro_v13_Blueprint` (no ext) + `.pdf` | `VoiceIsolate_Pro_v13_Blueprint` (text notice) + `VoiceIsolate_Pro_v13_Blueprint.DEPRECATED.md` |
| `V14.pdf` | `V14.DEPRECATED.md` |
| `VoiceIsolate_Pro_v5_Technical_Blueprint.docx` | `VoiceIsolate_Pro_v5_Technical_Blueprint.DEPRECATED.md` |
| `Installing VoiceIsolate Pro v5.2.pdf` + (no ext) | `Installing VoiceIsolate Pro v5.2` (text notice) + `Installing-VoiceIsolate-Pro-v5.2.DEPRECATED.md` |
| `voiceisolate-all.md` | `voiceisolate-all.md` (deprecation front-matter prepended) |
| `VoiceIsolate-Pro.md` | `VoiceIsolate-Pro.md` (deprecation front-matter prepended) |
| `voiceisolate-pdf.pdf` | `voiceisolate-pdf.DEPRECATED.md` |
| `VoiceIsolate-Pro-Complete-Overview.pdf` | `VoiceIsolate-Pro-Complete-Overview.DEPRECATED.md` |
| `VoiceIsolate-Pro-Complete-Overview.md` | `VoiceIsolate-Pro-Complete-Overview.md` (deprecation front-matter prepended) |

---

## Active / Authoritative Files — DO NOT DEPRECATE

| File | Role |
|------|------|
| `VoiceIsolate_Pro_v23_Blueprint.docx` | **CANONICAL SPEC** — 36-Stage Deca-Pass, Threads from Space v12 |
| `public/app/index.html` | Active UI |
| `public/app/style.css` | Active styles |
| `public/app/app.js` | Active DSP orchestration |
| `src/dsp-processor.js` | Active AudioWorklet |
| `package.json` | Active build config |
| `tsconfig.json` | Active TypeScript config |

---

## OrchestrAI Nexus — Cross-Project Deprecation Note

The following file belongs to the **OrchestrAI Nexus** project (separate repository) and must be deprecated there:

| File | Deprecated On | Superseded By | Reason | Status |
|------|--------------|---------------|--------|--------|
| `OrchestrAI Nexus File Creation Plan (1).pdf` | 2026-04-08 | `OrchestrAI Nexus File Creation Plan.md` | PDF duplicate of the .md version; the .md is the live, editable version and may be out of sync with the latest .md edits | **DEPRECATED** |

> **Action required:** Apply this deprecation to the OrchestrAI Nexus repository by prepending the standard `[DEPRECATED 2026-04-08]` notice to `OrchestrAI Nexus File Creation Plan (1).pdf` per the format defined by Randy Jordan.

---

*VoiceIsolate Pro Deprecation Log · Authority: Randy Jordan, Senior Audio-DSP Architect / AI Architect*
