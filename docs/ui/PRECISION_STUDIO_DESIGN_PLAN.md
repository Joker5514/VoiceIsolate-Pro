# Precision Studio design plan

This plan is the visual contract for the Precision Studio workstation redesign.
Supplied mockups override arbitrary layout randomization.

## Reference-to-route mapping

| Route | Primary reference | Supporting |
|---|---|---|
| `/` | `landing__precision-studio.png` + Professional Enterprise landing | Mobile-First landing for ≤640px |
| `/app/` | `engineer__enterprise.png` structure + `engineer__precision-studio.png` density | Mobile-First engineer for field layout |
| `/download/` | `download__precision-studio.png` environment cards | Provenance copy from current download page |
| `/app/how-it-works.html` | `how-it-works__precision-studio.png` pipeline | Prompt pipeline order |
| `/blueprint/` | `blueprint__precision-studio.png` operational dashboard | Factual architecture from `CLAUDE.md` |
| `/docs/claude-guide.html` | `contributor-guide__precision-studio.png` control room | Must not contradict `CLAUDE.md` |

Visual precedence used:

1. Professional Enterprise + Precision Studio for the default Studio shell.
2. Precision Studio for navigation, control density, and workstation behavior.
3. Mobile-First Field for Quick + narrow layouts (Drive does not contain `image-gen-2.png` or `image-gen-4.png`).
4. Enterprise analysis/compare presentation for measurable results (Drive does not contain `image-gen-5.png`).
5. Futuristic Signal OS for Forensic Mode chrome only (Drive does not contain `image-gen-3.png`).
6. Signal Lab for forensic storytelling accents, not the default shell.

`image-gen-1.png` … `image-gen-5.png` were not present in the shared Drive folder. Implementation uses the 18-page V2 pack and Precision Studio sheets instead of invented replacements.

## Typography

Geist is not bundled in this repository and must not be loaded from a CDN.
Inter is forbidden as the default redesign font.

Stack:

- UI: `ui-sans-serif, system-ui, "Segoe UI", sans-serif`
- Mono / meters: `ui-monospace, "Cascadia Code", "Segoe UI Mono", Consolas, monospace`
- Tabular numerals on timestamps, LUFS, dB, percentages, meters

Landing hero is two lines: “Clean voice. / Keep the evidence.”

## Token map

```
--surface-root: #070b10
--surface-panel: #0d131b
--surface-raised: #121a23
--border-subtle: #1d2a34
--text-primary: #f4f7fa
--text-secondary: #8d9aaa
--action-process: #ff3d4d   /* process / commit */
--action-live: #2ed5e5      /* Live-Mix / playback */
--state-success: #31cf7d    /* local / ready */
--state-warning: #f0b541    /* caution / whisper */
--source-secondary: #9b6cff /* alternate source class */
```

Semantic color is never the only indicator. Radii 6–10px. Thin borders. Minimal glow.

## Grid calculations

Desktop 1440×900

- Titlebar 48px
- Left nav 220px
- Right inspector 320px
- Center canvas remaining (~900px)
- 12px gutters, 8px inner

Tablet 1024×768

- Sidebars collapse to overlay drawers
- Center canvas full width minus 16px padding
- Inspector as a slide-over, not a shrunk desktop rack

Phone 390×844

- Bottom nav 64px + safe-area: Files | Analyze | Mix | Export
- Inspector as bottom sheets
- One primary action per task
- Waveform/spectrogram remain the first canvas

## Component inventory

Shared: titlebar, logo mark, environment cards, status chips, honest empty metrics, pipeline steps, product-mode cards.

Workstation: workspace nav, session context, waveform/spectrogram stage, source lanes (real diarization only), process inspector (existing sliders), A/B, export, engine/model status, field bottom nav, Quick progress strip.

Forensic: Signal OS chrome on the existing forensic tier. Region overlays only when analysis data exists; otherwise “unavailable”.

## Interaction and motion

Marketing: restrained hover/focus, no GSAP (not installed).

Workstation: no cinematic scroll, no control drift on hover, `prefers-reduced-motion: reduce` disables nonessential motion. Sliders never start ML.

## Accessibility risks

- Dense meter walls need text equivalents and `--` empty states.
- Bottom sheets must restore focus.
- 44×44 touch targets on field nav and primary actions.
- Color-only Live-Mix vs Process distinction is paired with labels.
- Heading order: one `h1` per surface.

## Performance budget

- No extra CDN fonts/scripts.
- No new render loops; reuse existing canvases.
- Hidden panels do not add animation.
- Landing JS transfer must not grow by a new framework.

## Mockup override confirmation

Layout, palette, navigation, and product mapping come from the downloaded Drive mockups listed above. Decorative mockup numbers (Voice 84%, LUFS −14.2, fabricated confidence) are **not** copied into production. Real `updateAudioMetrics()` / mixer / model-health values replace them, or the UI shows an unavailable state.
