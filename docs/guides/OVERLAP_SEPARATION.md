# Overlapping-speaker separation (VIP-016)

Status: research + baseline. No prototype is runnable and nothing is
integrated — deliberately, because the acceptance gate is unmet (see
below). This document is the research record and the integration
gate, not a design promise.

## The problem, stated against evidence

The current pipeline is single-speaker separation: one vocal stem
plus a residual. On the 4 licensed overlap clips in the admitted
corpus (SpeechBrain LibriSpeech separation mixtures; target = the
primary speaker), every shipped chain goes backwards:

| Chain | Overlap SI-SDR delta | Speech-level delta | Fricative delta |
|---|---|---|---|
| landing (BSRNN) | −3.18 dB | −2.42 dB | +13.69 dB |
| engineer (BSRNN) | −3.96 dB | −4.11 dB | +12.52 dB |
| maximum (BSRNN+RNNoise) | −3.53 dB | −3.18 dB | +12.59 dB |
| enhance (DFN3) | −11.34 dB | −35.43 dB | −27.81 dB |

Enhance (DeepFilterNet3) nearly mutes overlap mixtures — it treats
the second speaker as noise and gates almost everything. The
diarizer cannot help here either: it emits one label per frame by
construction (overlap DER floor 0.51 on synthetic fixtures, and it
cannot represent two simultaneous speakers at all).

## Approaches considered (local-first constraints)

Any candidate must run on-device (WASM, no audio egress), fit the
app's memory budget, and not destabilize Stem-Split/Live-Mix:

- **Multi-speaker time-domain separation** (Conv-TasNet / DPRNN /
  SepFormer style, ONNX): the principled fix — separates N speaker
  streams. Costs: a new model (tens of MB), a new inference path,
  permutation-invariant training data, and a speaker-count/assignment
  problem (which stream is "speaker 1"?). No such model is shipped,
  fetched, or evaluated here.
- **Diarization-guided masking**: use diarization turns to pick
  which single-speaker stem dominates each interval. Cheap, but it
  does not separate simultaneous speech — it just switches between
  intervals. It is a presentation improvement, not separation.
- **Target-speaker extraction**: ECAPA embedding of an enrolled
  speaker steering extraction (the `score`/`cluster` path in
  SpeakerEmbeddingWorker is adjacent to this). Promising for the
  "isolate this person" use case, but it needs an enrolled target and
  does not produce all speakers' stems.
- **Do nothing (current state)**: overlap stays a documented
  limitation. The product must not claim overlap separation it does
  not have, and Enhance must not be offered on overlap content
  without the guard that already exists for low-SNR fixtures.

## Trade-offs (for a future candidate)

| Dimension | What to measure before integrating |
|---|---|
| Quality | Overlap-class SI-SDR delta + speech-level + fricative deltas on the corpus (same protocol as CORPUS_THRESHOLDS.md) |
| Compute | RTF on 60/300/900 s (same protocol as stress-long.cjs) |
| Memory | Peak RSS vs the 2 GB bar |
| Model size | Download + cache cost (ECAPA is 24.9 MB for scale) |
| Latency | Cold start (model load) + first-output latency |
| Assignment | How stream→speaker labels are decided, and what happens when the speaker count is wrong |

## Integration gate (VIP-016 box 5)

Integrate only if a candidate meets the Phase 2 acceptance criteria
(`docs/guides/CORPUS_THRESHOLDS.md`) on the overlap class: mean
SI-SDR delta >= 0 dB, speech-level within ±3 dB, fricative delta
>= −6 dB — plus no regression on the single-speaker classes. No
existing chain meets this on overlap, so nothing is integrated.
A runnable prototype behind a capability flag is the next step when
a candidate model is chosen; it does not exist yet, and box 2 stays
open for exactly that reason.
