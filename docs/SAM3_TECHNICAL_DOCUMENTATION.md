# SAM 3 for VoiceIsolate Pro

## Status and verification

This document records the SAM 3 technical brief supplied for the VoiceIsolate Pro project. Claims about release dates, checkpoints, benchmark values, licensing, and API details must be verified against Meta's official repository, model card, paper, and license before production use. SAM 3 is primarily a vision/video segmentation model; it is not an audio-separation model and must not be placed inside the real-time audio DSP path.

## Overview

SAM 3 (Segment Anything Model 3) is described as a promptable concept-segmentation model for text prompts, visual prompts, exhaustive multi-instance segmentation, and video tracking. The supplied brief describes an 848M-parameter unified detector/tracker architecture, a shared vision encoder, a presence token for distinguishing similar concepts, a DETR-based detector, and a SAM 2-derived tracker.

Reported capabilities in the supplied brief include open-vocabulary text prompts, clicks, boxes, exemplar masks, persistent video tracking, and multi-instance segmentation. Reported dataset and benchmark claims include SA-Co, 4M+ automatically annotated concepts, 270K benchmark concepts, and the supplied LVIS/COCO/SA-Co/SA-V results; these numbers are retained as project notes and require source verification before publication.

## VoiceIsolate Pro integration boundary

SAM 3 should operate as an optional local video-vision sidecar that produces per-frame subject masks, bounding boxes, confidence scores, and track IDs. The audio engine remains governed by VoiceIsolate Pro's strict constraints:

- 100% local processing; no cloud APIs, telemetry, or external fetches except local model assets.
- Exactly one forward STFT and one inverse STFT in the spectral phase.
- In-place spectral operations to avoid phase smearing.
- ONNX Runtime Web with WebGPU preferred and WASM fallback for browser-compatible audio ML.
- AudioWorklet for Live mode and OfflineAudioContext for Creator/Forensic mode.

A SAM 3 mask can be used to select or track a visual speaker/object, then map that selection to an audio source, camera channel, diarization result, or user-selected segment. SAM 3 must not be assumed to identify a speaker from pixels alone; audio speaker verification and source separation remain separate systems.

## Intended use cases

1. Track a selected person across video frames and preserve the selection through cuts and movement.
2. Let a user enter prompts such as `the speaker in white` or `the person at the podium`.
3. Produce a subject mask for video effects while VoiceIsolate Pro processes the associated audio locally.
4. Support multiple tracked subjects and allow the user to bind a visual track to an audio channel or speaker embedding.
5. Use conservative confidence thresholds and expose manual correction when segmentation is uncertain.

## Proposed browser architecture

- Main UI: prompt entry, frame preview, mask overlay, track list, confidence, manual correction.
- Vision worker: local SAM 3 inference where a browser-compatible model/runtime is available; otherwise expose an explicit unsupported-runtime state rather than silently sending media to a server.
- Shared memory: transfer frame tensors and mask buffers with Transferable objects or SharedArrayBuffer only when cross-origin isolation is enabled.
- AudioWorklet: receives only compact control events, track selections, and time-aligned metadata; it continues to own deterministic low-latency DSP.
- Audio ML worker: performs local ONNX Runtime Web inference outside the Worklet and publishes bounded results through a ring buffer.
- Offline path: Creator/Forensic mode may batch frames, smooth masks temporally, and preserve an audit trail.

## Data contract

```ts
type Sam3FrameResult = {
  frameIndex: number;
  timestampMs: number;
  tracks: Array<{
    trackId: number;
    label: string;
    score: number;
    box: [number, number, number, number];
    mask?: Uint8Array;
  }>;
};
```

The audio pipeline should consume only validated metadata. Bounds-check frame indexes, reject malformed masks, cap the number of simultaneous tracks, and never block the real-time audio callback waiting for vision inference.

## SAM 3.1 Object Multiplex note

The supplied brief describes a March 2026 SAM 3.1 Object Multiplex update using shared memory for joint multi-object tracking and a `facebook/sam3.1` checkpoint. Treat this as an unverified integration note until confirmed in the official repository and model card. Implement the adapter behind a feature flag so the baseline tracker remains functional.

## Installation and deployment notes

The supplied brief lists Python 3.12+, PyTorch 2.7+, CUDA 12.6+, and a CUDA-capable GPU for the reference implementation. Those requirements apply to a native/server-side reference workflow, not automatically to VoiceIsolate Pro's browser runtime. The browser build must preserve local-only processing and should use a separately packaged, browser-compatible model/runtime only after licensing, memory, and performance validation.

## Official resources from the supplied brief

- GitHub: https://github.com/facebookresearch/sam3
- Hugging Face: https://huggingface.co/facebook/sam3
- Meta AI: https://ai.meta.com/research/sam3/
- Paper: https://arxiv.org/abs/2511.16719
- Playground: https://segment-anything.com/

Verify availability, access requirements, version compatibility, and license terms before adding any dependency or model asset.

## Grok Coder implementation prompt

```text
You are a senior computer-vision, audio-DSP, WebGPU, WebAssembly, and browser-platform engineer. Integrate SAM 3 into the existing VoiceIsolate Pro repository without violating its local-only audio architecture.

Repository: Joker5514/VoiceIsolate-Pro

First inspect the repository and existing architecture. Do not overwrite working audio code. Produce a plan, identify the exact files to change, and implement only after checking the current build and test conventions.

Goal:
Add an optional local vision pipeline that uses SAM 3 for promptable image/video segmentation and tracking. SAM 3 is not an audio separator. It must remain a vision sidecar whose results are time-aligned with, but operationally separate from, the audio DSP and ONNX audio inference paths.

Hard constraints:
1. 100% local processing. No cloud inference, telemetry, analytics, remote upload, or external API calls. Only explicitly configured local model assets may be loaded.
2. Do not add network fetches to arbitrary domains. Use packaged/local assets or an explicit local development path and fail clearly when assets are unavailable.
3. Preserve the single-pass spectral design: exactly one forward STFT and one inverse STFT, with in-place spectral operations.
4. Never run heavy SAM or audio ML inference inside the AudioWorklet callback.
5. Keep Live mode real-time safe: no allocations, promises, blocking waits, DOM access, or unbounded loops in process().
6. Prefer WebGPU for browser ML where supported, with WASM fallback. Detect unsupported runtimes explicitly.
7. Preserve Creator and Forensic OfflineAudioContext paths and retain an auditable mapping from visual track IDs to audio processing decisions.
8. Do not claim SAM 3 can identify a speaker from visual pixels alone. Require optional audio diarization, voiceprint, or channel mapping for speaker identity.

Deliverables:
- src/sam3_integration/image_segmenter.js
- src/sam3_integration/video_tracker.js
- src/sam3_integration/text_prompt_handler.js
- src/sam3_integration/types.js or equivalent runtime validation module
- src/sam3_integration/worker.js for off-main-thread inference when supported
- public/app/sam3-worker.js or the repository's existing equivalent location
- tests for prompt validation, frame ordering, mask validation, track persistence, and local-only policy
- docs/SAM3_TECHNICAL_DOCUMENTATION.md updates if implementation details differ
- a concise README section explaining model acquisition, licensing, browser support, and local setup

Required behavior:
- Accept text prompts, boxes, clicks, and exemplar-mask references through a typed command interface.
- Return frameIndex, timestampMs, trackId, label, score, bounding box, and optional compact mask data.
- Support multiple instances with configurable limits.
- Smooth or associate tracks temporally without blocking audio.
- Expose confidence thresholds and manual correction hooks.
- Use Transferable objects or SharedArrayBuffer only when cross-origin isolation is available; provide a safe fallback.
- Send only bounded, validated track metadata to the AudioWorklet.
- Add feature detection for SAM 3/SAM 3.1 runtime and keep the adapter behind a feature flag.
- Add structured error handling for missing model assets, unsupported execution providers, invalid frames, and out-of-order results.

Testing and acceptance criteria:
- npm test and the repository's lint/typecheck commands pass.
- No new remote endpoint or telemetry path is introduced.
- The audio Worklet remains stable when vision inference is delayed or unavailable.
- Results arriving out of order are rejected or safely reordered.
- Memory usage is bounded for long videos and multi-object tracking.
- Tests cover at least 10 simultaneous tracks and dropped-frame recovery.
- Document how to verify local-only behavior in browser DevTools.
- Report files changed, commands run, known limitations, and any SAM 3 API assumptions that still require verification against official Meta sources.

Before coding, inspect package.json, existing workers, AudioWorklet files, model-loading code, security headers, and test scripts. Keep the implementation modular, production-oriented, and compatible with the existing JavaScript style.
```
