# VoiceIsolate Pro — Persistence / Cache / Separation Audit

**Date:** 2026-07-31  
**Role:** Principal Audio DSP Engineer · Senior Web Platform Architect · Code Audit Lead  
**Constraint posture:** Assume work loss, recompute waste, and transient-memory overuse until proven otherwise.  
**Phases:** Audit complete → implementation follows in same change set.

---

## Executive summary

VoiceIsolate Pro is a **local-first** voice isolation product (Web / Electron / Android) with a sound offline-vs-Live-Mix split, deferred decode on Engineer upload, and real ONNX model caching. It does **not** currently give users durable **audio work**.

| Layer | Proven status |
|-------|----------------|
| UI chrome (slider locks, collapsible sections, workflow tier) | Durable (localStorage) |
| ONNX model bytes | Durable (IndexedDB / desktop FS) — dual schema risk |
| Uploaded source files, stems, analysis, processed audio | **Heap / object URL only — lost on reload** |
| Slider session module (`session-persist.js`) | **Loaded but never called** |
| Stem re-use (`MLStemCache`) | In-memory only; cleared on file change, clear, **and worker reset** |
| BufferPool | Implemented, **unused** by hot path |
| Desktop ↔ Android project sync | **Missing** |

**Root cause of “files disappear after leaving the browser”:**  
`handleFile` keeps a live `File` / `Blob` on `this._sourceFile` and decoded PCM on `inputBuffer`/`origBuffer`. Nothing writes the blob to OPFS/IndexedDB. Reload discards the JS heap; the OS file picker grant is gone. Object URLs for video preview die with the tab.

**Architecture rule check:** Local-only processing is respected. Single-pass STFT is an intended offline contract but is not automatically enforced by a central spectral gate; multi-copy buffer residency is the larger practical violation of resource discipline.

---

## Bug / risk table

| ID | Severity | File/path | Problem | Why it happens | User impact | Fix strategy |
|----|----------|-----------|---------|----------------|-------------|--------------|
| P-01 | **P0** | `public/app/app.js` (`handleFile`, `_sourceFile`) | Uploaded files vanish after reload/close | Source kept only as in-memory `File` + heap AudioBuffers | Re-upload + re-decode + re-ML | FileLibrary + OPFS/IDB blob store + session restore |
| P-02 | **P0** | `public/app/session-persist.js` + `index.html` | Session save/load is dead code | Module imported; `saveSession`/`loadSession` never called from app | Slider/preset work lost on refresh | Wire save/load to VIP_PARAMS; restore on boot |
| P-03 | **P0** | `src/pipeline/MLStemCache.js` + `StemSeparation.js` | Stem cache session-only; cleared on ML timeout | `resetStemSeparation()` calls `clearStemCache()` | Full re-inference after stall | Keep stem Map across worker recycle; skip re-ML when stems retained |
| P-04 | **P0** | `app.js` `_runMLIsolationPipeline` | Reprocess always re-enters ML path | No short-circuit on `_cleanStemChannels` | Wasted minutes of GPU/CPU | If stems present for `fileSeq` and `!force`, skip ONNX |
| P-05 | **P1** | `MLWorker.js` vs `ml-worker-fetch-cache.js` | Same IDB name, different version/schema | v1 key-value vs v2 keyPath records | Model re-download / open failures | Unify schema; single writer |
| P-06 | **P1** | `app.js` ML isolation path | 15–25× float residency per stereo clip | Mid copy + expand + AudioBuffer + stem channels + cache deep-copy + mixer | OOM / tab kill on long files | Single-owner stems; cache by reference or disk chunks |
| P-07 | **P1** | `src/core/BufferPool.js` | Dead pool | No production imports | Extra GC during DSP | Wire into STFT/mid or drop claims |
| P-08 | **P1** | `public/app/pipeline-state.js` `SpeakerRegistry` | IDB save/load never used by app | API exists; no integration | Lost speaker profiles | Call load on boot or remove |
| P-09 | **P1** | Landing vs Engineer | Two separation hosts | Landing posts to its worker; Engineer uses `StemSeparation` | Divergent bugs; no shared stem disk cache | One host API |
| P-10 | **P1** | Download page / releases | `latest` may still resolve to v24 assets | README notes version drift | Broken “latest” installers | Pin release assets to versioned tags |
| P-11 | **P2** | PWA / `sw.js` | Shell cache only; no library sync | SW not a data plane | Android/desktop libraries diverge | Project export pack + optional device sync later |
| P-12 | **P2** | Google Fonts in `index.html` | External CSS request | `fonts.googleapis.com` | Network dependency; conflicts “no external APIs” spirit | Self-host fonts |
| P-13 | **P2** | Analysis workspace | Analysis only in `_lastFullAnalysis` | No content-addressed store | Re-run Analyze every session | Cache analysis JSON keyed by file id |
| P-14 | **P1** | Architecture | No OPFS/project model | Never implemented | No library / projects | Implement FileLibrary + ProjectStore (Phase 2) |

---

## Performance bottleneck table

| Stage | Current issue | CPU/GPU/memory impact | Recommended optimization | Expected improvement |
|-------|---------------|----------------------|--------------------------|----------------------|
| Decode | Full main-thread / OfflineAudio decode; no persistent PCM | High CPU once per session | Persist source blob; optional chunked decode cache | Instant restore of file presence; decode only first open |
| Model load | Dual IDB + cold ORT compile | Disk + 30–120s first compile | Single cache; keep worker warm; avoid reset on stall | Fewer full warmups |
| ML isolate | Stereo mid OK; still multi-copy; reprocess re-enters | High GPU/WASM | Skip if stems retained; durable stem cache | Reprocess ~instant when only sliders change |
| Stem cache miss | Weak fingerprint key | Wrong or forced miss | Hash file id + model chain | Correct hits |
| Analysis | Full-file features + channel transfer copies | High CPU + peak RAM | Session cache by library id | Second Analyze free |
| Spectral DSP fallback | Correct single STFT intent; allocates freely | CPU + GC | BufferPool / reuse mid | Fewer frame drops |
| Visuals | Idle waveform re-render ok | Medium main-thread | Cache peaks by file id | Faster re-open |
| Live-Mix | Correct: no re-ML on sliders | Low | Keep | — |

---

## Persistence / storage map

| Data type | Current storage | Why lost | Correct long-term storage |
|-----------|-----------------|----------|---------------------------|
| Imported source file | JS `File` on `app._sourceFile` | Tab lifetime | **OPFS** bytes + **IDB** metadata (fallback: IDB blob) |
| Decoded PCM | `AudioBuffer` heap | Tab lifetime | Do **not** keep full float permanently; re-decode from source or chunked cache |
| ML stems | Heap + `MLStemCache` Map | Reload / clear / worker reset | Optional OPFS stem packs keyed by fileId+models; else re-run ML |
| Analysis result | `_lastFullAnalysis` | Reload | IDB JSON by `analysisCacheKey` |
| Slider params | Dead session-persist | Never saved | localStorage `vip-session-v2` (wire existing module) |
| Slider locks | localStorage | Survives | Keep |
| Presets (custom) | Partial / modal | Fragile | IDB `presets` store |
| Projects | None | N/A | IDB `projects` + file links |
| Model weights | IDB `vip-model-cache` | Survives (usually) | Keep; unify schema |
| Object URLs | Video preview | Revoked / tab kill | Reconstruct from OPFS/IDB blob |
| Forensic log | Heap array | Reload | Optional IDB or export-only |
| Desktop↔Android | None | N/A | Portable project archive (zip of meta+blobs), user-mediated sync |

---

## Sync architecture proposal (desktop + Android / Iodé)

**Principle:** 100% local. No cloud sync service. Cross-device continuity is **user-mediated** or **same-device multi-surface**.

```
┌─────────────────────┐     optional USB/share      ┌─────────────────────┐
│ Desktop (Electron/  │  ──── Project Pack (.vip) ──│ Android WebView/PWA │
│ Browser)            │                              │ Iodé browser        │
│ FileLibrary (OPFS)  │                              │ FileLibrary (IDB/   │
│ ProjectStore (IDB)  │                              │  OPFS if available) │
└─────────────────────┘                              └─────────────────────┘
         │                                                      │
         └──────── same origin / Capacitor filesystem ──────────┘
                    (Android build: library under app sandbox)
```

1. **Canonical unit:** Project Pack — JSON manifest + source blobs + optional stem/analysis caches.  
2. **Import/export:** User exports pack; imports on other device (share sheet / file pick).  
3. **Same device:** Single origin storage; Engineer + Landing share FileLibrary.  
4. **No telemetry / no remote identity.**  
5. Future optional: local LAN transfer only if user enables (out of scope now).

---

## Patch plan (priority order)

| Step | Priority | Deliverable |
|------|----------|-------------|
| 1 | P0 | FileLibrary + BlobStore (OPFS/IDB) + metadata catalog |
| 2 | P0 | Session restore bootstrap + library UI (list/open/remove/delete) |
| 3 | P0 | Wire `handleFile` to persist (import modes) |
| 4 | P0 | Wire `session-persist` for slider params |
| 5 | P0 | Skip re-ML when stems retained; stop clearing stem cache on worker reset |
| 6 | P1 | ProjectStore + Save to project mode |
| 7 | P1 | Analysis/status metadata updates |
| 8 | P2 | Project pack export/import (sync primitive) |

---

## Implementation status

**Phase 2 (this change set) — done:**

| Item | Status |
|------|--------|
| `src/core/storage/*` OPFS + IDB blob backends | Done |
| `src/core/FileLibrary.js` catalog + session bootstrap | Done |
| `src/core/ProjectStore.js` named projects | Done |
| `src/presentation/FileLibraryUI.js` + Engineer Upload panel | Done |
| `app.js` persist on import, restore on boot, open/remove/delete | Done |
| Import modes: temporary / library / project | Done |
| `session-persist` wire-up (`persistAppSession` / restore) | Done |
| Stem cache: do not clear on worker reset | Done |
| Skip re-ML when stems retained for `fileSeq` | Done |
| Tests: `tests/file-library.test.js` | Done |

**Follow-up completed in same PR stream:**

| Item | Status |
|------|--------|
| Durable stem + analysis caches (`DerivedCache.js`) | Done |
| Project pack `.vippack` export/import (`ProjectPack.js`) | Done |
| Unified model IDB v3 key-value schema | Done |
| Landing → FileLibrary persist on ingest | Done |
| BufferPool wiring / self-host fonts | Deferred (non-blocking) |
