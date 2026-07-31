# VoiceIsolate Pro — Performance & Persistence Overhaul

**Date:** 2026-07-31  
**Role:** Browser performance · DSP · storage/recovery · ruthless audit  

## Executive findings (pre-fix)

| Area | Issue | Impact |
|------|--------|--------|
| Library import | Every upload created a **new** catalog id | Duplicate tracks, unbounded growth |
| Restore | Full blob hydrate (fixed partially) still fragile | OOM / slow boot |
| Stems | Deep copies + uncapped durable packs | RAM + slow process |
| Sliders | Persist + Live-Mix on every `input` | Main-thread thrash |
| Params | Critical state in **localStorage** | Quota / lost / not multi-tab safe for large |
| Caches | No central version / orphan prune | Stale derived + disk bloat |
| Decode | Full re-decode always | Slow reopen |
| Waveform | `renderStaticVisuals` every load | Canvas thrash |

## Design decisions (implemented)

### Track model (max 5)
- At most **5** library tracks (`MAX_LIBRARY_TRACKS = 5`).
- **One canonical row per content fingerprint** — re-importing the same file updates the existing track.
- Evict **oldest by updatedAt** when over capacity (with derived/blob purge).

### What is cached vs not

| Cached | Where | Never cached |
|--------|-------|--------------|
| Source blob | OPFS / IDB | Full PCM Float32 permanently |
| Stem packs (size-capped) | DerivedCache | Multi-hour full-float stems |
| Compact analysis JSON | DerivedCache | Frame feature matrices |
| Track params/status | TrackState IDB | Binary audio |
| Model ONNX bytes | model IDB v3 | — |
| Slider locks / UI chrome | localStorage OK | Critical project binary |

### Crash-safe save
- Track params → **IndexedDB** via debounced `scheduleSaveTrackState`.
- `pagehide` / `visibilitychange` flush.
- Crash guard still skips one auto-hydrate after unclean exit.

### Performance
- Content-fingerprint upsert import.
- Debounced Live-Mix + track save (rAF + 120ms coalesce for bridge).
- Stem channel reuse (no map-copy when already owned).
- Waveform render throttled; skip if same buffer fingerprint.
- Startup `ensureCacheFresh` + orphan derived prune.
- MLStemCache LRU cap (2 entries).

## Privacy
All local. No network for audio/state. Models same-origin only.
