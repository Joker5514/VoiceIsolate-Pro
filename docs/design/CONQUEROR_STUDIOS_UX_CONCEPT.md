# Conqueror Studios — VoiceIsolate Pro UX concept

## 1. Improved UX concept

The product should feel like a **private audio workstation with a guided path**, not
an AI demo or a settings dashboard. The primary journey is Import → Separate & Mix
→ Export. Technical depth remains available, but the interface earns complexity as
the source becomes ready. Persistent local-processing language and observable engine
status provide trust without invented performance claims.

The shipped first increment adds a compact, sticky workflow navigator, a keyboard
skip link, and explicit progressive-disclosure language on the locked Live Mix area.

## 2. Screen-by-screen recommendations

### Landing / first impression

- Lead with the user outcome and local-processing promise.
- Keep one primary action (Upload & isolate); present Engineer mode as secondary.
- Explain the three-step mental model before presenting product modes.
- Avoid unverified quality percentages, customer counts, or comparison claims.

### Import

- Keep drag/drop and Browse files as the dominant actions; Drive remains optional.
- After selection, replace generic idle copy with filename, duration, format, and an
  explicit readiness state.
- Explain model tradeoffs in plain language (recommended, speed, download size).
- Keep Separate stems disabled until a valid local decode has completed.

### Processing

- Show named stages, determinate progress when measurable, elapsed time, and Cancel.
- Preserve the last meaningful state if processing fails; never clear the source.
- Explain that processing is local and that the mix controls will not re-run ML.

### Live Mix

- Keep transport, three primary mix controls, and A/B comparison above advanced DSP.
- Treat the unprocessed state as locked, not broken; state what action unlocks it.
- Reveal export beside the completed result rather than advertising a disabled action.

### Speaker focus and export

- Show speaker tools only when detection produces actionable segments.
- Make format, estimated size, destination, and crop range clear before export.
- Confirm local download or user-initiated Drive transfer with a recoverable result.

## 3. Component system

- **Foundations:** 4/8 px spacing rhythm, semantic surface/border/text tokens, red for
  process actions, cyan/green for live or healthy state, and monospace for measurements.
- **Actions:** primary process button, secondary/ghost action, icon button, switch, and
  minimum 44 × 44 px coarse-pointer target.
- **Status:** state chip, inline alert, progress stage, engine/provider badge, and empty
  state with one next action.
- **Workflow:** sticky step navigator, section heading with availability state, cards,
  progressive disclosure, transport, slider row, and export summary.
- **Feedback:** skeleton only where geometry is known, stage-aware loader for real work,
  actionable inline errors, and success confirmation that names the saved destination.

## 4. Design direction

Use a restrained **precision studio** language: near-black layers, thin technical
borders, high-contrast type, sparse glow reserved for live signal and primary process
states, and real signal visualizations only. Keep marketing content visually quieter
than the workspace. Motion should communicate state, never decorate idle screens.

## 5. User flow

1. User understands the local-processing promise and selects a source.
2. The product validates and decodes locally, then recommends a separation mode.
3. User explicitly starts separation and sees stage-level progress or cancels.
4. Completed stems unlock playback; the user listens, A/B compares, and adjusts mix.
5. Optional advanced DSP or speaker focus refines the result without re-running ML.
6. User chooses an export destination and receives a clear completion state.
7. The source and settings remain available for retry after recoverable failures.

## 6. Accessibility requirements

- Meet WCAG 2.2 AA: 4.5:1 text contrast, 3:1 large text and control boundaries.
- Preserve visible focus, logical source order, landmarks, heading hierarchy, and a
  skip link to the audio workspace.
- Give every icon control an accessible name and every status update an appropriate
  polite or assertive live region without duplicate announcements.
- Support keyboard upload, transport, sliders, disclosure controls, and export.
- Never rely on color alone; pair state color with text, shape, or iconography.
- Respect reduced motion, 200% text zoom, reflow at 320 CSS px, and screen readers.

## 7. Implementation priorities

1. **Now:** orient users with the persistent workflow map, clear locked states, and
   keyboard bypass; retain all pipeline IDs and bindings.
2. **Next:** drive workflow-step completion from the existing pipeline state and add a
   focused source summary after decode.
3. **Next:** consolidate empty/loading/error patterns into shared presentation-layer
   components and audit live-region announcements.
4. **Later:** add a first-run recommended path, an explicit original/processed A/B
   control, and an export review sheet informed by observed usability sessions.
5. **Measure:** source-selection completion, processing starts, processing failures,
   successful first playback, and export completion—locally and without audio telemetry.
