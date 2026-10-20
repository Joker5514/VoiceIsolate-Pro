# VoiceIsolate Pro — Premium Cinematic UI Concepts

**Status:** visual concept and design handoff. This document proposes a cohesive five-screen direction; it does not claim a UI implementation or runtime verification.

## Creative direction

Give VoiceIsolate Pro the tactile authority of a mastering console and the atmosphere of a premium studio render. Keep the working plane orthographic, sharply focused, and calm. Let depth, reflections, and cinematic lighting live in artwork and panel edges; never make text, meters, or controls look like they recede in perspective. The interface's signal colors carry meaning: cyan is Clean Voice, gold is Background, and neutral silver is Original/Full Mix.

**Product flow:** Import → Choose outcome → Process locally → Level-matched A/B → Adjust Voice/Background → Export.

### Shared tokens

| Token | Value / rule | Meaning |
|---|---|---|
| Canvas | `#0A0E14` | Deep blue-black studio |
| Surface 1 | `#111821` | Main application plane |
| Surface 2 | `#18222D` | Raised panels and controls |
| Surface 3 | `#202C38` | Hover/pressed recesses; opaque enough for text |
| Voice cyan | `#22D3EE` | Clean Voice waveform, lane, and state |
| Background gold | `#F5B942` | Background waveform, lane, and state |
| Reference silver | `#C5CED8` | Original and Full Mix reference |
| Primary text | `#F4F7FA` | Headlines, labels, and essential values |
| Secondary text | `#B8C5D3` | Explanations, units, and metadata |
| Success / warning / error | restrained green / labeled amber / labeled red | Never use hue as the only state cue |
| Spacing | 4 px base; 8 px rhythm | Compact console detail without arbitrary gaps |
| Corners | 8 px controls; 12 px panels; 18 px hero surfaces | Consistent, restrained radii |
| Borders | 1 px cool graphite; brighter on focus/selection | Defines smoked glass without relying on translucency |
| Elevation | subtle contact shadow + narrow edge highlight | Depth on a stable, readable plane |

Use a neutral grotesk for interface text (Inter or system sans fallback), a compact semibold face for section headings, and tabular monospaced numerals (JetBrains Mono or system monospace) for time, dB, Hz, and values. Desktop labels target 12–14 px, body copy 14–16 px, and headline 32–48 px. Mobile body copy stays at least 16 px. Keep normal text at 4.5:1 contrast or better; recheck actual rendered states before implementation.

### Shared shell and components

- **Desktop frame:** 16:10 viewport, 12-column content grid, 24 px outer gutter, 16 px panel gap. Header is a stable 64 px plane. Persistent transport is 76–88 px high. Keep main controls above decorative artwork.
- **Session header:** VoiceIsolate Pro mark, current surface, filename, truthful processing/local status, and primary Export action. Filename truncates with an accessible full-name label.
- **Panels:** smoked graphite with 92%+ opaque reading surfaces, subtle bevel, fine edge highlight, and restrained cyan key / gold rim. Glass is decoration around content, never behind small text.
- **Signal key:** cyan label + waveform + icon for Clean Voice; gold label + waveform + icon for Background; silver label + distinct icon for Original and Full Mix. Pair color with text and shape/pattern.
- **Waveform lanes:** same time ruler and scale when compared. Use a crisp neutral baseline, non-color playhead, explicit lane labels, meter values, and visible selection outline.
- **Transport:** Play/Pause, seek with time readout, loop when available, A/B comparison, and Export. Controls are disabled with a reason before processed audio exists. Never show a recording or microphone control.
- **Controls:** the current Engineer console uses recessed faders with calibrated ticks and synchronized numeric entry; do not depict rotary knobs. Provide a keyboard-operable number field and increment/decrement buttons beside each fader.
- **Touch:** every actionable target at least 44 × 44 px, with at least 8 px between adjacent targets. On desktop, hover may add edge light; it must not be required to reveal function.
- **State language:** default is quiet graphite; hover adds a small edge lift; focus uses a 2 px high-contrast cyan outline plus a non-color cue; pressed moves inward; selected adds border, icon, and text treatment; disabled dims without hiding the reason; loading shows stage text and an indeterminate indicator unless real progress exists; error is inline, actionable, and announced to assistive technology.
- **Motion:** 150–250 ms opacity/transform transitions. No animated width/height, drifting camera, or always-on particles in work areas. Follow `prefers-reduced-motion`; keep all status information visible in static mode. Rendering effects must never gate audio controls.

## Screen 1 — Landing / Import

**Purpose:** explain the product quickly and make local audio import the obvious first action.

**Desktop composition (16:10):** compact top navigation; left-aligned copy in the upper-left third; sculptural signal in the right/center two-thirds; a clear lower-left action row beneath the hero. The signal begins as one textured silver waveform, then divides into two traceable translucent ribbons: cyan Clean Voice and gold Background. Keep copy and CTA on the flat foreground plane. Add sparse, out-of-focus particles only in the backdrop. Beneath the hero, place two small, aligned demo waveform cards with Original, Clean Voice, Background labels and an A/B comparison, each visibly marked **Demo**. Keep the privacy statement adjacent to Import audio in the action row.

**Exact copy:** “Bring the voice forward.” / “Separate voice and background. Process locally. Shape the mix.” / Primary: “Import audio” / Secondary: “Explore the studio” / “Audio processing stays on your device.”

**Mobile (390 px):** stack headline, short supporting line, import CTA, then a cropped but fully traceable signal illustration. Secondary action and demo cards follow. CTA remains visible without horizontal scroll; no hero perspective may cross the text column.

**Interaction:** Import opens the supported file picker/drop zone. The sample is illustrative only and never auto-plays. The Explore action is a proposed navigation affordance until mapped to an existing route. Demo comparison must be visibly labeled and must not imply measured improvement.

**Image-generation prompt:**

> Use case: ui-mockup. Asset type: premium desktop product landing screen concept, 16:10 landscape. Primary request: design the VoiceIsolate Pro landing screen with exact copy “Bring the voice forward.”, “Separate voice and background. Process locally. Shape the mix.”, “Import audio”, “Explore the studio”, “Audio processing stays on your device.” Include readable labels “Original”, “Clean Voice”, “Background”, and “Demo”. Scene/backdrop: straight-on dark blue-black audio studio, with one sculptural silver waveform entering from the left and splitting into two separate, traceable signal ribbons, cyan for Clean Voice and warm gold for Background; sparse soft-focus particles behind the interface. Composition: keep all typography and controls on a flat, sharp foreground plane; place the copy in the upper-left, the hero signal across center/right, and the two compact aligned demo waveform cards beneath it. Place both CTAs in a clear lower-left action row below the hero, with the privacy statement adjacent to “Import audio”. Style/medium: polished commercial 3D product visualization combined with a credible professional audio application UI. Palette: canvas #0A0E14, charcoal/smoked graphite surfaces, electric cyan #22D3EE, warm gold #F5B942, near-white text, neutral silver reference. Materials: believable thick smoked glass, opaque frosted reading surfaces, brushed anodized edges, fine bevels and contact shadows. Lighting: soft cyan key light from upper left and warm gold rim light from upper right, controlled reflections, restrained bloom, readable dark details. Camera: straight-on application viewport; perspective only in hero ribbons; no depth of field on interface. Constraints: clean hierarchy, crisp correctly spelled text, generous negative space, no fake testimonials or metrics, no microphone, no recording dashboard, no cloud processing, no watermark.

## Screen 2 — Engineer Workstation

**Purpose:** precise, dense, credible control over processing and the playback mix.

**Desktop composition (16:10):** session header across the top; left parameter browser (about 22% width); central waveform/timeline (about 48%); right processing rack (about 30%); persistent bottom transport and output meters. The central timeline shows a readable ruler, playhead, selected lane, and optional loop/crop region on a flat plane. The left browser is scrollable and grouped. The rack shows the supported 10-band graphic EQ as a legible response curve/grid, plus Gate, Compressor, and Limiter groups using their real labels and units. Use recessed faders with calibrated ticks and numeric readouts throughout; this console has no rotary knobs. Avoid filling every panel above the fold.

**Control organization:** preserve all 67 controls: 37 Live-Mix, 27 process-time spectral, two stereo post-stem, and one encoder-only dither. Use a persistent mode tag and section heading to show which controls apply immediately to playback, which require Process, which are stereo post-stem, and which affect export encoding only. Show useful examples in the initial viewport and indicate the remaining count per group; the complete registry remains reachable by scroll/search. Never put dither in the Live-Mix rack.

**Example visible controls:** 10-band EQ frequency/gain, Gate Threshold/Range/Attack/Release, Compressor Threshold/Ratio/Attack/Release, Limiter Ceiling/Release, Voice and Background level. Display numeric values and units beside every visible control. Any unsupported region-selection palette is explicitly a proposed interaction; basic loop/crop controls are shown only as the existing transport affordance.

**Mobile (390 px):** waveform and transport stay in the main view. Parameter browser and rack become labeled drawers/accordions with clear “Live-Mix” and “Requires Process” sections. Keep values beside faders and use full-width numeric entry; no sideways rack scrolling.

**Image-generation prompt:**

> Use case: ui-mockup. Asset type: premium audio-engineer workstation screen, 16:10 landscape. Primary request: a credible VoiceIsolate Pro Engineer console with filename/status header, left scrollable parameter browser, large central waveform timeline with time ruler and playhead, right 10-band EQ response graph plus Gate, Compressor, and Limiter groups, and persistent bottom Play/Pause, seek, loop, A/B, Export, and output meters. Include readable section tags “LIVE-MIX”, “REQUIRES PROCESS”, “STEREO”, “EXPORT”, values with Hz/dB/ms units, and signal labels “Clean Voice” and “Background”. Scene/backdrop: restrained dark studio atmosphere behind a completely straight-on, sharp, usable console. Composition: 22/48/30 left/center/right hierarchy with stable flat work plane; keep meters and values crisp; do not cram all controls into the first viewport. Style: premium commercial audio plugin meets cinematic 3D product render. Palette: #0A0E14 canvas, smoked charcoal/graphite, cyan #22D3EE for Clean Voice, gold #F5B942 for Background, silver reference, near-white text. Materials: thick smoked-glass panel edges, opaque reading surfaces, recessed faders with calibrated engraved ticks and synchronized numeric readouts, subtle bevels and contact shadows; no rotary knobs. Lighting: consistent soft cyan key from upper left and warm gold rim from upper right, restrained bloom only on active signal and indicators. Camera: straight-on, no perspective distortion on controls, no depth of field over the interface. Constraints: exact readable labels, legible frequency grid, professional spacing, full-mix reference only, no microphone, no recording controls, no cloud inference, no invented latency or performance claims, no watermark.

## Screen 3 — Stems

**Purpose:** make the two separated results easy to understand, compare, balance, and export.

**Desktop composition (16:10):** shared session header and source filename; a broad timeline with three aligned lanes; a compact right-side balance/meter area; persistent transport. Clean Voice and Background have independent labeled waveforms, meters, gains, and supported mute/solo controls. Full Mix is a neutral silver playback/reference lane that combines those two stems; it is not a third AI-separated output. All lanes share one time axis and playhead. Original comparison is a separate A/B mode rather than a fourth stem lane.

**Export choices:** state targets clearly as Voice, Background, or Mix. A Mix export combines the current two-stem playback balance. Show A/B against Original and its level-match status without implying the source file is modified. Keep a color-independent mute/solo state: icon shape, text, and `aria-pressed` change together.

**Mobile (390 px):** one lane per row, stacked vertically with label and gain first, waveform second, and meter/actions grouped in a 44 px minimum target row. Keep the playhead and transport shared. Avoid 3D ribbon overlap with text or export controls.

**Image-generation prompt:**

> Use case: ui-mockup. Asset type: premium separated-stems mixer screen, 16:10 landscape. Primary request: show exactly three aligned lanes labeled “Clean Voice”, “Background”, and “Full Mix”. Cyan marks Clean Voice, warm gold marks Background, and neutral silver marks Full Mix. The Full Mix lane must visually read as a playback/reference combination of the first two lanes, not an AI-separated stem. Include independent lane waveform, level meter, gain, mute/solo controls for the two separated stems; show Original as a separate comparison mode with A/B and level-match status. Export targets read “Voice”, “Background”, “Mix”. Scene/backdrop: dark cinematic studio, three translucent signal ribbons with subtle spatial depth behind/around stable flat control surfaces. Composition: shared ruler, aligned waveforms and playhead; roomy lane labels at left, waveforms centered, compact meters/actions at right, bottom transport clear. Style: polished commercial audio software, physically convincing 3D accents with professional UI readability. Palette: #0A0E14 canvas, smoked graphite panels, #22D3EE voice, #F5B942 background, #C5CED8 reference, near-white text. Materials: thick smoked-glass edges, sufficiently opaque content surfaces, subtle brushed metal and contact shadows. Lighting: cyan upper-left key, gold upper-right rim, restrained bloom. Camera: straight-on work plane; spatial depth only on the ribbons, never across controls; no interface depth of field. Constraints: explicit text and color-independent state, Full Mix is a playback sum/reference, no “third stem” badge, no microphone, no recording, no cloud inference, no watermark.

## Screen 4 — Quick Clean

**Purpose:** make the first local result feel calm, understandable, and easy to review.

**Desktop composition (16:10):** a short step rail across the top: Import → Choose outcome → Process locally → Compare → Export. Center three spacious, opaque smoked-charcoal outcome cards for the supplied concept: Podcast Voice, Music Vocal, and Call Audio. Use frosted-glass treatment only on the cards' edge trim, not behind text. Each card has one consistent line icon, one outcome sentence, a clear selected border plus icon/text change, and restrained cyan illumination. The concept uses these three labels as requested; the current implementation exposes four different Quick Clean outcomes (Clean Speech, Maximum Isolation, Preserve Ambience, Enhance Speech), so map or approve the proposed cards before treating them as shipped labels. “Call Audio” is for an imported recording only.

After Process is pressed, show a progress ring only during active work. Use actual progress only when the runtime supplies it; otherwise show an indeterminate ring with a truthful stage message. Keep Cancel visible while cancellable, provide a concrete error and Retry where appropriate, and preserve the selected outcome on retry. On success, foreground level-matched A/B, Voice/Background balance, and Export. Do not display a countdown or promise completion time.

**Mobile (390 px):** cards become one-column, full-width selection rows. Step rail wraps or becomes a short vertical progress list; never shrink labels to fit. Primary Process/Export action and transport stay reachable; advanced controls move into a secondary disclosure.

**Image-generation prompt:**

> Use case: ui-mockup. Asset type: calm premium Quick Clean local-processing screen, 16:10 landscape. Primary request: show a clear five-step rail “Import”, “Choose outcome”, “Process locally”, “Compare”, “Export”; three generous opaque smoked-charcoal outcome cards titled exactly “Podcast Voice”, “Music Vocal”, and “Call Audio”; use subtle frosted-glass only on the card edge trim, never behind small text. Give each card a simple matching line icon, one concise outcome description, and a selected state conveyed through border, icon, and text. Include “Call Audio · imported recording” to prevent any microphone implication. Show a truthful local-processing badge, a visible primary Process button, and a compact post-process area with level-matched A/B plus Voice and Background balance controls. Scene/backdrop: low-noise dark studio atmosphere; generous negative space; no progress ring unless the card is in the processing state. Palette: canvas #0A0E14, opaque smoked-charcoal cards, cyan #22D3EE as the restrained selection accent, gold #F5B942 for Background, near-white readable text. Materials: subtle glass edge highlights, fine bevels, soft contact shadows, brushed edge details; all text surfaces remain opaque. Lighting: soft cyan key upper left and warm gold rim upper right, controlled reflections, no excessive neon. Camera: straight-on and sharply focused across all text and controls. Constraints: treat the three outcome names as proposed labels, do not include invented progress percentages, success metrics, testimonials, latency, microphone, recording dashboard, cloud processing, or watermark.

## Screen 5 — Live Mix

**Purpose:** communicate immediate control over playback of already processed stems.

**Desktop composition (16:10):** shared header with imported filename and status badge **“Live mix · Local playback”**. Put a large but subordinate circular visualizer above/behind the controls. It responds only to playback amplitude: concentric cyan and gold rings represent Clean Voice and Background energy; when paused, rings settle; before audio loads, they remain quiet. Place prominent Voice and Background faders on the stable foreground plane. Bottom transport contains Play/Pause, seek/time, level-matched A/B, and Export. Keep “processing” distinct from “playing”; moving either fader must only change playback mix and must not imply a new AI run.

**Mobile (390 px):** use a small circular visualizer above two full-width vertical faders. Keep both numeric values, Play/Pause, A/B, and Export readable and reachable. When space is tight, collapse visual detail before shrinking controls.

**Image-generation prompt:**

> Use case: ui-mockup. Asset type: premium Live Mix playback screen, 16:10 landscape. Primary request: show an imported filename, exact badge “Live mix · Local playback”, a circular playback-amplitude visualizer with concentric cyan Clean Voice and gold Background rings, two prominent labeled Voice and Background faders with numeric values, and a bottom Play/Pause, seek/time, level-matched A/B, Export transport. The rings are quiet before audio loads and settled in the paused state. Scene/backdrop: dark acoustic studio atmosphere, controlled stage lighting, subtle spatial depth only in the decorative visualizer. Composition: interface remains a straight-on flat plane; the visualizer is centered above and behind the two faders but never overlaps their labels; transport and filename stay sharp and unobstructed. Palette: #0A0E14 canvas, smoked graphite surfaces, cyan #22D3EE for Clean Voice, warm gold #F5B942 for Background, silver Original reference, near-white text. Materials: thick smoked-glass panel edges, opaque reading surfaces, brushed anodized details, subtle contact shadows and restrained bloom. Lighting: soft cyan key from upper left, warm gold rim from upper right, consistent across the series. Constraints: playback of already processed local stems only; no microphone input, no recording controls, no live noise-suppression inference, no AI indicator reacting to fader movement, no invented latency, no watermark.

## Shared negative prompt

> Flat generic SaaS cards; unreadable transparent glass; low contrast; tiny text; pseudo-text or misspellings; dense decorative labels; controls at perspective angles; blurred working interface; excessive neon, rainbow gradients, or bloom; ornamental controls with no function; incorrect signal colors; Full Mix shown as an AI-separated third stem; invented performance numbers, testimonials, or latency; microphone, recording dashboard, cloud inference, or live-mic workflow; fader movement depicted as triggering AI; extra controls that imply unsupported behavior; cartoon material; moving camera; watermark; renderer-resolution claims such as “8K” presented as actual output.

## Responsive, interaction, and motion specification

| Concern | Desktop | Mobile at 390 px | Reduced motion / constrained GPU |
|---|---|---|---|
| Working plane | 16:10, straight-on, stable panel grid | Single-column; no horizontal overflow | Static surfaces; no real-time 3D requirement |
| Parameter density | Scrollable groups and progressive disclosure | Labeled drawers/accordions; values stay adjacent | Remove particles, bloom, blur, and reflections first |
| Transport | Persistent bottom bar | Sticky bottom action/transport with safe-area padding | No animated transport chrome |
| Focus | Visible 2 px outline and text/icon state | Same, with 44 × 44 px minimum target | Focus never depends on glow or motion |
| Selection / mute / solo | Color + border + icon + text | Same; adequate spacing | Same static state |
| Process | Real progress only if supplied; otherwise stage-based indeterminate state | Same, with Cancel and Retry reachable | Render progress using CSS or static SVG; audio remains responsive |
| Playback motion | Waveform/meter updates follow playback | Simplified meter and waveform; no visualizer crowding | Static waveform still shows playhead/time; visualizer may be omitted |
| Transitions | 150–250 ms opacity/transform | Same, with no drawer motion when reduced motion is on | Respect `prefers-reduced-motion`; no camera motion |

All controls need keyboard operation, accessible names, visible focus, and a non-rotary alternative for rotary values. Errors appear beside the affected action and are announced; status is not communicated only by color. Recheck text contrast and touch geometry in implementation at actual viewport sizes.

## Proposed vs. verified behavior

**Verified from current project source/docs:** import and local offline processing; decode/resample to 48 kHz; separate Clean Voice and Background with the background as a residual; compare Raw/Processed/Removed; Voice and Background playback mixing; 67 registered Engineer controls in the 37/27/2/1 grouping; a 10-band graphic EQ; Gate/Compressor/Limiter controls; loop/crop transport; export; four current Quick Clean outcomes: Clean Speech, Maximum Isolation, Preserve Ambience, and Enhance Speech.

**Concept-only until mapped and reviewed:** the exact three Quick Clean labels Podcast Voice / Music Vocal / Call Audio; Explore the studio route; exact arrangement and visual skin of these five screens; the demo artwork and sample session; any new cross-surface navigation or card layout. A selected concept must not be represented as existing functionality merely because it appears in a render.

**Explicit product boundaries:** no live microphone ingestion, recording dashboard, cloud audio inference, or fader-triggered ML. Full Mix is a playback/reference combination, not a third separated stem. No measured speed, latency, or quality claim is introduced by these visuals. “8K”, ray-traced-style reflections, and Octane-like quality describe an art target only, not actual output resolution or renderer.

## Refinement passes and final audit

**Pass 1 — product and workflow corrections**

- Kept the production flow in the requested order and showed explicit local Process.
- Kept Full Mix as a neutral playback/reference sum and separated Original A/B from the output lanes.
- Marked the requested Quick Clean card labels as concept labels because the current product has four differently named outcomes; defined Call Audio as imported-file-only.
- Reserved progress percentages for real runtime progress and removed time-to-complete promises.
- Kept Live Mix strictly on already separated local playback; its faders do not imply inference.
- Grouped all 67 Engineer controls by when they apply, including the encoder-only dither control.

**Pass 2 — composition, consistency, and access**

- Standardized the signal palette, lighting direction, typography roles, panel treatment, focus state, and component spacing across all screens.
- Moved perspective and cinematic depth into decorative signal ribbons; kept working controls straight-on and sharp.
- Specified opaque reading surfaces, contrast requirements, 44 px touch targets, keyboard/number-entry alternatives, color-independent state, and reduced-motion/low-GPU modes.
- Required one prompt per screen plus a shared negative prompt, with explicit text and camera rules to reduce visual drift.

**Final audit:** product boundaries are represented accurately; visual language is consistent; readability and access requirements are specified; concept-only items are labeled. Any future renders are illustrative and require text/layout review before design approval. This package is not an implementation, runtime test, production-readiness finding, or claim about renderer fidelity.
