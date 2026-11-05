# Deferred model research (VIP-013 / 014 / 017 / 018)

Status: **research complete, benchmark evaluation NOT done.** None of
the four candidates has a model artifact in this repo, a manifest
entry, an ONNX export, or a worker adapter, so none has run against
the corpus benchmark (`CORPUS_THRESHOLDS.md` bars). Checking a box on
a literature review would misrepresent the issue, so all four boxes
stay open. This document records what each candidate is, what a real
benchmark run would require, and the verdict that gates that run.

## VIP-013: SCNet — first, disambiguate the name

"SCNet" names at least three different things, and a prototype spec
that does not say which one is not a spec:

- **Sparse Compression Network** for source separation (ICASSP
  2024; `starrytong/SCNet`): subband sparsity-based encoder, the
  family shipped in ZFTurbo's Music-Source-Separation-Training
  (MSST) as SCNet Small / Large / XL / XL-IHF. This is the only
  SCNet that fits the issue's context (it sits next to BS-RoFormer
  in the same training framework, and the issue pairs the two).
- A GAN vocoder's **Subband Condition Network** (speech
  generation, not separation) — wrong family for this product.
- A two-stage **suppression/compensation** speech-enhancement
  network (IEEE Access 2025, DNS-Challenge / VoiceBank-DEMAND
  results) — a genuine enhancement candidate, but a different
  model from the MSST one, with no shared weights.

**Benchmark entry criteria:** pin the exact variant + checkpoint,
its license, and an ONNX export; add a manifest entry with SHA-256;
write the worker adapter; run `corpus-eval.cjs` as a new chain and
score it against `CORPUS_THRESHOLDS.md`. Until then: not evaluated.

## VIP-014: BS-RoFormer / improved BSRNN

BS-RoFormer (band-split RoFormer, `lucidrains/BS-RoFormer`, MIT
code) is a music-separation architecture whose public vocal
checkpoints are large and license-messy:

- viperx vocal checkpoints (~610 MB `.ckpt`): weights license
  **ambiguous** — no author license published, originally released
  via a supporter paywall. Dev-build only until written terms
  exist; not shippable.
- KimberleyJSN Mel-Band RoFormer vocal checkpoint: MIT declared
  in the model-card metadata — the licensable path, if the card
  claim is verified against the card itself at acquisition time.
- ONNX exports exist in the wild (e.g. waveform 2-stem exports
  and host-STFT spectral exports), but the two export styles need
  **different adapters** — a waveform loader cannot run a
  spectral-I/O export. The export's I/O contract must be verified
  before any adapter is written.

Fit notes: 350–700 MB checkpoints and GPU-class expectations sit
badly against this product's WASM single-thread worker and mobile
tiers; a prototype would need quantization + a size budget before
it could be a default. The shipped `bsrnn_vocals` already IS a
BSRNN variant — "improved BSRNN" needs a named checkpoint, not a
direction. **Benchmark entry criteria:** same as SCNet, plus a
size/RTF budget decision for the mobile tiers.

## VIP-017: AudioSep (text-conditioned isolation)

AudioSep (Audio-AGI, "Separate Anything You Describe") is a
language-queried separation foundation model: QueryNet (CLAP text
encoder) + SeparationNet (frequency-domain ResUNet, FiLM
conditioning), 32 kHz, with published SDR improvements (AudioSet
7.74 dB, ESC-50 10.04 dB, Voicebank-DEMAND SSNR 9.21 dB). It is a
general-sound separator, not a speech enhancer — its speech value
comes from the Voicebank number, not from this corpus.

What a prototype would cost here: a text-query UI surface (new),
a CLAP text encoder + tokenizer in the worker, a ResUNet ONNX
export, 32 kHz resampling against the product's canonical 48 kHz,
and a manifest + adapter. It also changes the product contract
(query-driven isolation vs automatic separation), so it needs a
product decision before engineering, not just a benchmark run.
**Benchmark entry criteria:** product decision + pinned
checkpoint/license + ONNX exports (text encoder AND ResUNet) +
adapter + a corpus-eval chain; note the corpus has no text labels,
so a benchmark run also needs query strings per clip.

## VIP-018: CLAP (sound-event recognition for routing)

CLAP (Contrastive Language-Audio Pretraining) embeds audio and
text in one space; zero-shot classification is cosine similarity
between an audio embedding and label embeddings. The original
model pairs an 80.8M-parameter CNN14 audio encoder with a 110M
BERT text encoder — heavy for on-device use; lighter HTS-AT
variants exist but need their own pinning.

The box itself draws the line this evaluation keeps: CLAP is for
**classification/routing** (label a segment speech / noise /
music / event, then route processing), NOT a substitute for
separation. The product already has analysis/detection paths
(`ANALYSIS_CONTRACTS.md`); CLAP's marginal value is
text-queryable labels, which needs a product decision about what
routing decisions labels would actually change. **Benchmark entry
criteria:** pinned variant + license + ONNX export + mel frontend
+ a routing decision it changes + a labeled classification eval
(the corpus has class labels but no per-segment event labels, so
the eval set would need building).

## Common gate for all four

No candidate is integrated, promoted, or claimed as evaluated
until it has: a pinned checkpoint, a verified license, a SHA-256
manifest entry, a worker adapter, and a corpus-eval run scored
against `CORPUS_THRESHOLDS.md` — with the Phase 2 rule that a
candidate failing the bars (as every current chain does on
overlap) is not promoted. Research links are in the issue comments
for this round; model cards and licenses must be re-verified at
acquisition time, since third-party re-uploads are not the author.
