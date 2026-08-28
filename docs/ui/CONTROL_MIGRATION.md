# Existing-control migration map

Precision Studio is a shell around the current DSP application. No slider IDs, canvas IDs, or process/export buttons were renamed.

## Landing `/`

| Control | Previous location | New location |
|---|---|---|
| `#fileInput`, `#browseBtn`, `#openDriveBtn` | Upload panel | Same, below hero |
| `#modelSelect`, `#processBtn`, `#cancelProcessBtn` | Upload row | Same |
| `#playBtn` `#pauseBtn` `#stopBtn` `#seekSlider` | Live Mix transport | Same |
| Live-Mix sliders (`#noiseReductionSlider` … `#deEsserAmountSlider`) | Mix panel + advanced details | Same |
| `#waveCanvas` `#specCanvas` | Mix vis-block | Hero **Signal preview** (same IDs, moved) |
| `#muteVoiceBtn` `#muteNoiseBtn` `#presetSelect` | Transport | Same |
| `#downloadBtn` `#saveDriveBtn` | Export row | Same |
| `#speakersPanel` `#speakerCardsGrid` | Speakers card | Same |
| `#clearLocalDataBtn` | Privacy panel | Same |
| Engineer / Download links | Titlebar | Titlebar (`eng-mode-link` preserved) |

Intentionally not added: fabricated source-confidence percentages. `#sourceConfidencePanel` stays unavailable until analysis exists.

## Studio `/app/`

| Control | Previous | New |
|---|---|---|
| Full 67-control rack | Left/right columns via `engineer-console.js` | Same columns + left **workspace nav** (scroll/focus only) |
| `#fileInput` `#processBtn` | Session column | Media / Processing nav targets |
| `#spectroCanvas` `#waveCanvas` and viz tabs | Stage | Stage; Forensic nav “Observe” |
| `#btn-abcompare` `#abToggle` | Viz tabs / transport | Compare nav |
| `#exportBtn` `#exportProjectPackBtn` | Save row | Exports nav |
| `#heroTierPicker` Creator/Studio/Forensic | Hero | Labels **Quick / Studio / Forensic** (`data-hero-tier="creator"` unchanged) |
| Simple view toggle `#ecViewToggle` | Header | Settings nav + header |
| Integrity / output safety cards | Session | Audit nav |
| Mobile action bar | Existing | Plus field nav `Files \| Analyze \| Mix \| Export` |

No DSP control was removed. Quick is the existing Creator tier with a progress strip; advanced sliders remain in the rack.

## Forensic

Feature-flagged chrome (`body.ps-forensic`) when workflow tier is forensic. Region overlays are **not** invented; existing analysis/diarization cards remain the evidence surface.

## Download / docs

Download keeps APK/EXE/Web URLs and provenance language. How-it-works, blueprint, and contributor guide restyle only; they still defer to `CLAUDE.md`.
