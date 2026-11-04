# VIP-034 — Corpus acceptance thresholds

Defined **before** any corpus evaluation run (VIP-034 box 1) and before
any model is selected. These thresholds judge the corpus report
(`scripts/quality/corpus-eval.cjs`); they are not tuned to its results.
A chain is selected as a default only if it meets **all** bars below on
the admitted corpus (dataset 2026-11-03.v1, 36 clips, 8 classes). If no
chain meets them all, the report selects **none** and lists the gaps —
no promotion on a single favorable clip or class (VIP-034 box 5), and no
promotion on synthetic fixtures (issue rule 4).

## Quality bars (per class, per chain)

Metrics are defined in `scripts/quality/lib/metrics.cjs` (SI-SDR) and
the corpus eval script. Activity masks are reference-defined: 20 ms
frames of the reference whose RMS exceeds both −50 dBFS and the clip's
peak frame RMS minus 40 dB. The corpus is 16 kHz but the shipped models
reject non-48 kHz input, so input and target are both linearly
upsampled to 48 kHz (same filter both sides) and scored at 48 kHz;
fricative band is the gate's 3.5–9 kHz at that rate.

| Bar | Applies to | Threshold |
|---|---|---|
| Noisy-class improvement | Noisy classes (hvac, babble, street, field-recording, overlapping-speakers): mean SI-SDR delta (output vs input, both scored against the aligned clean target) | Mean ≥ 0 dB for the chain to be selectable; any class mean < 0 dB disqualifies the chain as a default |
| Clean preservation | Clean / quiet / whispered classes: SI-SDR of output scored against the clip itself (self-target) | Mean ≥ 15 dB (the chain must not materially distort already-clean speech) |
| Speech-level preservation | All classes: output speech-level minus reference speech-level over active frames | Mean within ±3 dB per class |
| Fricative preservation | All classes: output fricative-band energy minus reference fricative-band energy over active frames | Mean ≥ −6 dB per class (masks must not gut fricatives; the gate's Maximum chain measured about −30 dB on synthetic fricative onsets, which is the failure mode this bar exists to catch) |
| Invariants | Every run | 0 non-finite samples, output length == input length, peak ≤ 1.0. Any violation fails the run, not just the chain |

## Latency bars

- **Warm processing:** mean realtime factor (processing wall time /
  audio duration, excluding model load) < 1.0 for the default chain on
  this machine class (VM, WASM single thread). A chain slower than
  realtime cannot be the default.
- **Cold start:** worker init + first model load per chain, recorded in
  the report. No hard bar (cold start is a UX cost, not a quality
  claim), but a chain whose cold start exceeds 60 s is flagged as
  unsuitable for mobile defaults in the report.

## Memory / reliability bars

- **Coverage:** all 36 clips × all 4 chains measured, or the eval is
  reported **incomplete**, not passed. Missing or checksum-mismatched
  assets fail the run explicitly (VIP-006 box 5 rule).
- **Memory:** peak RSS during the eval < 2 GB on this machine class;
  per-chain processing time must not trend upward across clips (last
  clip ≤ 2× first clip for the same chain), which would indicate a leak
  or unbounded cache growth.
- **Reliability:** 0 crashes, 0 invariant failures across all runs.

## What is NOT measured (and why)

- **PESQ / STOI:** no validated implementation is bundled, and shipping
  an unvalidated reimplementation would be worse than omitting the
  metric. SI-SDR/SDR + speech-level + fricative-band are the objective
  measures; perceptual confirmation comes from the blinded listening
  comparisons (VIP-004 box 5), which need a human listener.
- **WER:** needs a pinned offline ASR; none is bundled (the #885 ledger
  already records this as the missing dependency).
- **Noise-only reduction:** the corpus has no noise-only clips, so
  noise reduction is read through SI-SDR delta and output-vs-input
  level on the noisy classes, not as a standalone figure.

## Selection rule (restated)

A chain is selected only on corpus evidence meeting every bar above,
across every class. Synthetic-gate results (quality-baseline.json) are
regression protection, not selection evidence. A single clip, a single
class, or an aggregate that hides a failing class never justifies
selection.
