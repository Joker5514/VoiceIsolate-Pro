# Speaker fusion: ECAPA-TDNN + diarization (VIP-015)

Status: research + prototype measurement. No production behaviour
changed. The fusion below is a specification for a future, separately
reviewed change — not a claim that it is implemented.

## What exists today (measured, not assumed)

- Diarization (`public/app/ml-worker.js` `runDiarization`): 200 ms
  windows, 100 ms hop, features `[RMS, zero-crossing rate, flatness]`,
  k-means with k forced to 2 (<10 s), 3 (<30 s), 4 (>=30 s).
  Measured baseline (`scripts/quality/diarization-eval.cjs`): 50%
  false-split rate on 14 known single-speaker corpus clips; two
  distinct synthetic talkers collapse to one surviving cluster
  (DER 0.58, confusion-dominated); a clean synthetic talker loses
  ~1/3 of speech frames to the silence threshold and the >=300 ms
  segment filter. Silence-only input correctly yields zero segments.
- `confidence` on diarization segments is energy-weighted
  (0.68 + normalized-energy × 0.29, capped 0.97). It is NOT a
  speaker-identity certainty and must never be presented as one. The
  timeline renders it as segment opacity only (no numeric claim) —
  that restraint should be preserved until a calibrated value exists.
- ECAPA-TDNN (`src/workers/SpeakerEmbeddingWorker.js`, model
  `ecapa_tdnn`, Wespeaker voxceleb 512-dim → 192-dim output here):
  optional, git-ignored, fetched + SHA-verified by
  `pnpm models:fetch-ecapa` (24.9 MB). When absent, the product falls
  back to the local mel voiceprint (`extractLocalVoiceprint`) — that
  fallback is the current production behaviour and stays available
  regardless of what follows.
- Local mel voiceprint: measured nearly useless for discrimination
  (same-source mean 0.904 vs cross-clip mean 0.805 on the probe) —
  it mostly measures speech-likeness/channel, not identity. It must
  not assert identity on its own.

## ECAPA consistency probe (unlabeled — not identification accuracy)

`scripts/quality/ecapa-consistency.cjs` (8 clips, halves as
same-source pairs; cross-clip pairs as an upper bound, since the
corpus has no speaker labels and some clips may share a speaker):

| | ECAPA | mel |
|---|---|---|
| same-source mean | 0.669 | 0.904 |
| cross-clip mean / median | 0.17 / 0.085 | 0.805 / 0.867 |
| separation (same − cross median) | ~0.58 | ~0.04 |

ECAPA separates same-source from cross-clip pairs; mel does not.
One cross-clip ECAPA pair scored 0.967 — consistent with two clips
sharing a speaker, which is exactly why cross stats are an upper
bound, not a different-speaker score. Runtime: 745 ms init, ~176 ms
per embedding, on-device (WASM, no egress). Privacy: embeddings are
voice biometrics — they must stay on-device, never leave with audio
or alone, and enrollment must remain explicit and user-initiated.

## Fusion specification (proposed, not implemented)

1. Segment embeddings: for each diarization segment >= 0.5 s, run the
   worker's `cluster` message (mean ECAPA embedding per diarization
   speaker id, capped at 10 s per segment). Segments < 0.5 s keep no
   embedding and are never identity-labeled.
2. Assignment: a segment's speaker label is the enrolled centroid
   with the highest cosine similarity, ONLY if the margin over the
   runner-up exceeds a calibrated threshold AND the top similarity
   exceeds a calibrated floor. Otherwise the segment is labeled
   "unknown" — never the nearest centroid by default.
3. Confidence: report the calibrated margin (top − runner-up), not
   energy. The current energy number must be renamed or removed when
   this lands so the two are never confused.
4. Thresholds: set from labeled data with `scripts/quality/
   speaker-eval.mjs` (FRR/FAR/EER per speaker), NOT from the
   consistency probe. The existing `DEFAULT_SIM_THRESHOLD` (0.42)
   sits inside the probe's plausible zone (same-source min 0.505,
   cross median 0.085) but is NOT validated — do not bless it as
   calibrated.
5. Fallback ladder: ECAPA present → ECAPA assignment; ECAPA absent →
   diarization labels only (S1/S2, no identity) + mel similarity
   shown as a weak hint, never an identity; no model → no identity
   claims at all.
6. No hard dependency: ECAPA stays optional. Any change that makes
   it required needs the labeled evidence from (4) first.

## What is still open (VIP-015 boxes 3–4)

Labeled multi-speaker recordings (speaker ids + turn boundaries) do
not exist in the admitted corpus. Until they do: no identification
accuracy, no false-attribution rate, no calibrated threshold, no
EER. `speaker-eval.mjs` is the tool that measures them the day the
data exists; the consistency probe is not a substitute.
