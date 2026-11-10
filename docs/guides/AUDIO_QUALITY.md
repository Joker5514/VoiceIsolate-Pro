# Audio quality measurement

VoiceIsolate Pro measures separation quality objectively. Nothing here is a
listening test; it pins the shipped signal path so a change that makes the
audio worse fails a gate instead of shipping.

## Commands

| Command | What it does | Runtime |
|---|---|---|
| `pnpm test:quality` | Gate: 9 fixtures x 4 profiles (landing, engineer, maximum, enhance = DeepFilterNet3) through the production `MLWorker.js` with the shipped ONNX models; hard invariants plus 88 pinned metrics (SI-SDR, speech level, fricative-band level, noise reduction). Also `prod:verify` step `audio-quality`. | about 30 s |
| `node scripts/quality/quality-gate.cjs --update` | Re-pin `scripts/quality/quality-baseline.json` after an intended change. The diff is the review record. | about 30 s |
| `pnpm quality:matrix -- --secs 6 [--json out.json] [--only id,id]` | Full 15-scenario x 3-profile report (markdown table). | about 2.5 min |

## How it runs

`scripts/quality/lib/mlworker-node.cjs` loads the real `src/workers/MLWorker.js`
source in a Node `vm` sandbox with the vendored `onnxruntime-web` (WASM, one
thread, so results are deterministic) and serves `/app/models/*.onnx` from
disk. The worker still verifies every model's SHA-256 against
`ModelManifest.js`. Nothing in the inference path is reimplemented.

Profiles:

| Profile | Chain | Engineer snapshot |
|---|---|---|
| `landing` | `bsrnn_vocals` | none (Landing sends none) |
| `engineer` | `bsrnn_vocals` | registry defaults through `getEffectiveDspParams` + `buildMlProcessingConfig`, exactly as `app.js` builds it |
| `maximum` | `bsrnn_vocals` + `rnnoise` (fused) | none |

## Fixtures

`scripts/quality/lib/signals.cjs` synthesises deterministic, license-free
speech-like signals: a band-limited glottal source (or noise, for whisper)
through three formant resonators, syllable envelopes with pauses, and
4-8 kHz fricative onsets. Noise beds: white, fan/HVAC, 60 Hz hum with
harmonics, sawtooth-triad music, synthetic babble, room reverb (RT60 0.5 s),
hard clipping, silence. Every speech scenario knows its ground-truth target;
the silence and noise-only fixtures have none and are scored by output level.

These are proxies. They catch regressions in the shipped path; they do not
certify absolute quality on recorded speech. Recorded-speech evidence for
calibration changes is gathered locally (see below) and is not committed.

## Metrics

| Metric | Meaning |
|---|---|
| SI-SDR | Scale-invariant SDR of the clean stem against the dry target (dB). Used as absolute preservation for clean inputs. |
| SI-SDR delta | SI-SDR(output) minus SI-SDR(input). Positive means the output is closer to the target than the input was. |
| speech-level | Clean-stem RMS level minus target RMS level over active speech, in dB (gate). Catches a quieter output that SI-SDR, being gain-invariant, cannot. |
| fricative-level | Clean-stem minus target energy in 3.5-9 kHz over fricative onsets, in dB (gate). Guards consonant loss that aggregate SI-SDR barely registers. |
| noise-reduction | Input RMS level minus clean-stem RMS level on a noise-only input, in dB. |
| level, HF 4-12 kHz, fricative, gap leak | Matrix only: level change in speech, high-band change in speech, energy change on fricative onsets, residual in pauses. |

Hard invariants in the gate: no NaN or Infinity, length preserved, digital
silence in gives peak below 1e-6 out, no output sample above full scale.

The measured and pinned metric sets must match exactly (a new metric fails
until it is pinned) and every metric must be finite. `--update` re-pins the
current metric set, but refuses to write a baseline if the run breaks a hard
invariant or produces a non-finite metric.

## Model calibration (2026-10-07)

Two inference-time settings live in `ModelManifest.js` per spectral model and
are applied inside the one fused STFT pass:

- `inputNormalization: 'frame-max'`. `scripts/export_onnx_models.py` trains
  both networks on magnitude frames divided by their per-frame peak. The
  worker previously fed raw magnitudes. BSRNN is insensitive to this (within
  0.1 dB); RNNoise improved by 1 to 3 dB SI-SDR on recorded speech.
- `maskExponent: 0.5`. The mask is applied as `mask^0.5`, halving its
  attenuation in dB. Swept over p = 1, 0.75, 0.6, 0.5, 0.4, 0.3 on three
  LibriSpeech utterances (CC BY 4.0) mixed with white, HVAC, music and hum;
  mean SI-SDR delta on the noisy inputs peaked at p = 0.4 for the default
  chain (p = 0.5 within 0.1 dB) and was still rising at p = 0.3, the lowest
  value tried, for the Maximum chain. p = 0.5 was chosen as the smaller step
  that keeps more suppression. It was then checked on held-out audio (a fourth LibriSpeech utterance and three 20 s
  LibriVox excerpts, public domain) and raised SI-SDR in all 7 conditions
  for both chains.

Tradeoff, stated plainly: noise-only suppression drops from 5.6 to 5.1 dB
(default chain) and from 26.9 to 17.7 dB (Maximum chain). The masks remove
too much speech at p = 1; the softer mask keeps more speech and slightly
more noise, and the net result is closer to clean speech on every measured
input.

Even after calibration the shipped default chain makes some inputs worse
(held-out white noise at 10 dB SNR: -1.2 dB SI-SDR; music at 5 dB: -0.9 dB;
babble at 5 dB: -0.7 dB). Both networks were trained from scratch on
synthetic frames and see one 85 ms frame at a time. A better model is the
only fix for that; see `docs/archive/REIMAGINE-multi-frame-models.md`.

## Mains hum, Maximum chain and improvement tier (2026-10-14)

Measured with the gate harness (synthetic fixtures) and on four LibriSpeech
utterances from `Narsil/asr_dummy` (mixed locally, not committed). Mean SI-SDR
delta on recorded speech, old -> new:

| Condition | Default chain | Maximum chain |
|---|---|---|
| clean (absolute SI-SDR) | 13.81 -> 13.77 | 10.75 -> 13.75 |
| white 5 dB | 2.06 -> 2.05 | 4.11 -> 4.52 |
| HVAC 5 dB | 2.75 -> 2.75 | 2.28 -> 3.10 |
| music 5 dB | 0.17 -> 0.18 | -0.52 -> 0.12 |
| 60 Hz hum 10 dB | 1.77 -> 2.38 | -0.49 -> 2.36 |
| 50 Hz hum 10 dB | 1.73 -> 3.08 | -0.45 -> 2.99 |

The default-chain clean drop (16.69 -> 16.54 dB on one utterance) is real
100.02 Hz mains buzz in that recording, steady to 0.02 Hz across the file;
the reference contains it, so removing it costs SI-SDR against that reference.

- **Mains hum notch** (`src/workers/MainsHumFilter.js`, run by MLWorker once
  per channel per Process before the model chain). Detects a stationary 50/60 Hz series
  (fundamental may be missing) from long-window spectra, then applies a
  zero-phase notch per detected harmonic up to Nyquist: Q 30 at the
  fundamental and the same ~2 Hz bandwidth at every harmonic, each centred on
  its measured frequency. A per-harmonic Q of 30 would overlap into a comb
  above ~1.8 kHz. The noise stem is still the residual against the original
  input, so the removed hum is audible there. Once a hum series is detected,
  a sustained tone exactly on one of its harmonics is notched with it.
- **Maximum chain exponent.** `rnnoise.chainMaskExponent: 0.15` applies when
  rnnoise follows BSRNN in the fused chain; BSRNN keeps `maskExponent: 0.5`
  and the single-model defaults are unchanged. The old product
  `bsrnn^0.5 * rnnoise^0.5` cut fricatives by about 31 dB and speech level by
  6-10 dB on the fixtures (the "maximum de-essing" seen in audits). Swept
  rnnoise at 0.5, 0.25, 0.15 and 0.1; 0.15 improved SI-SDR, speech level and
  fricative level on every fixture (fricatives about -12 dB). An exponent of
  0.65 lowered every speech metric. Tradeoff: noise-only suppression on the
  Maximum chain falls from 17.7 to 9.8 dB (default chain: 5.0 dB).
- **Improvement tier.** Scenarios tagged `improvementExpected` (white 5 dB,
  HVAC 5 dB, hum 10 dB, whisper in white 10 dB) list every scenario/profile
  pair that measures SI-SDR delta >= 0 in `improvementRequired`; those must
  stay >= 0 dB with no tolerance, and `--update` refuses to drop one. The
  one exit (rule change 2026-11-10, owner-approved) is an explicit entry in
  the baseline's `improvementWaivers` (`{ key: reason }`): the gate prints it
  on every run, `--update` keeps it, and the pair rejoins the tier and loses
  the waiver as soon as it measures >= 0 dB. The first waiver was
  `whisper-white-10db/landing/si-sdr-delta` (-0.03 dB) after PR #895 removed
  the always-on 8.4 kHz shelf: the synthetic talker stops at 7 kHz, so the
  restored air band scored as noise there. The mask-aware HF post-filter
  (below) brought it to +1.35 dB, so it rejoined the tier and the waiver is
  gone. Tagged
  pairs still below 0 dB print as `improvement gap` on every run. On the
  synthetic fixtures the default and Engineer chains are still below 0 dB on
  white, HVAC and hum: the model alone scores only 6.4 dB SI-SDR on clean
  synthetic speech, below the 8.3 dB of the hum fixture's input, so no
  pre-filter can make that delta positive.

Measured and not shipped: a tonality-aware over-subtraction factor in the
Engineer noise reduction (stronger on flat noise floors, weaker on harmonic
ones) moved every Engineer metric by about 0.1 dB, and weakening subtraction
on music lowered music SI-SDR (-1.79 -> -2.03 dB). `SpectralCleanup.js` is
not on any production path, so changes there would not reach users.

## Mask-aware HF post-filter (2026-11-10)

PR #714 hid the masks' HF noise leak with an always-on shelf (gain 1 -> 0.45
from 8.4 kHz to Nyquist on every mask, unity included); PR #895 removed it so
a unity mask reconstructs 12 and 16 kHz tones at about 140 dB SDR, and HF
noise came back (white 5 dB SI-SDR delta -1.00 -> -2.13 dB on the default
chain, noise-only suppression 5.00 -> 3.26 dB). The measured cause: BSRNN's
mask is about 0.03 at 8-16 kHz on white noise but about 0.85 above 16 kHz,
and after the 0.5 exponent that band keeps almost all of its noise.

`src/workers/HfPostFilter.js` runs inside the fused STFT (after the masks,
before the Engineer frame processor; no extra STFT). Per bin above 7 kHz
(full weight from 9 kHz) the gain is
`1 - w(f) * u(mask) * (1 - p) * (1 - 0.15)`:

- `u(mask)` is 0 for a fused mask >= 0.995 and 1 at <= 0.9 (smoothstep), so
  a unity or confident mask is never touched (bit-identical output, pinned
  by `tests/hf-postfilter.test.js`).
- `p` is a soft speech-presence probability from a minima-controlled
  recursive-averaging noise tracker on the unmasked input power: 3-bin and
  60 ms smoothing, minimum over two 0.75 s sub-windows, bias 1.66 (Cohen and
  Berdugo, IEEE SPL 9(1), 2002; Martin, IEEE TSAP 9(5), 2001), mapped through
  a 7-14 dB a posteriori SNR ramp (60 ms smoothing; a strong onset opens at
  once), as
  OM-LSA uses its speech-presence probability (Cohen and Berdugo, Signal
  Processing 81(11), 2001; Gerkmann and Hendriks, IEEE TASLP 20(4), 2012).
  A strong onset (instantaneous SNR 6 dB past the ramp) counts from its
  first frame.
- The gain is smoothed over 3 bins (an isolated pass-through bin is pulled
  down to its neighbours) and its decay is capped at 0.6 per 10 ms, the cap
  RNNoise uses (Valin, MMSP 2018). The depth ramps in over the first 0.75 s
  so a file that opens on speech is not taken for noise.
- Floor 0.15 (-16.5 dB). RNNoise and DeepFilterNet3 (Schröter et al.,
  Interspeech 2023) apply band gains up to 20/24 kHz; this is the same idea
  gated by the separation mask.

Gate (synthetic, 4 s), PR #911 -> this filter (pre-#895 in brackets):
white 5 dB SI-SDR delta landing -2.13 -> -0.51 (-1.00), engineer -1.35 ->
-0.51 (-0.73), maximum 0.16 -> 0.55 (0.46); noise-only suppression 3.26 ->
5.98 (5.00), 6.14 -> 7.81 (7.26), 9.08 -> 10.07 (9.75); whisper in white
10 dB landing -0.03 -> +1.35 (0.95); clean speech 6.40 -> 6.40 (6.38).
Speech-level pins on noisy fixtures fell (white 5 dB landing -1.81 -> -2.33)
because that metric includes the residual noise: the projected speech
component moved by at most 0.05 dB (see the PR's re-pin table).

Limits: the tracker treats any HF content that stays steady for over ~1 s
under an uncertain mask (a held cymbal, a steady HF tone) as noise; a
confident mask still protects it. The recorded corpus is all 16 kHz, so it
has nothing above 8 kHz and cannot show this filter; fullband checks used
48 kHz VCTK recordings (CC BY 4.0) with synthetic noise.

## DeepFilterNet3 speech enhancement (2026-10-14)

`deepfilternet3` is the pretrained DeepFilterNet3 (Schröter et al., MIT OR
Apache-2.0), shipped as its three upstream ONNX graphs and run by
`src/workers/DeepFilterNet.js`, a port of libDF 0.5.6 (960-point STFT, hop
480, 32 ERB bands, order-5 deep filter on the lowest 96 bins). The port
matches libDF's own Python pipeline around the same graphs at 55 dB SI-SDR on
recorded speech and above 40 dB on the committed fixture
(`tests/fixtures/dfn3-libdf-output.f32`). It is opt-in: Landing outcome
**Enhance Speech**.

Recorded speech, same protocol and four LibriSpeech utterances as the table
above. Mean SI-SDR delta (clean row: absolute SI-SDR):

| Condition | Default chain | Maximum chain | DeepFilterNet3 |
|---|---|---|---|
| clean (absolute) | 13.77 | 13.75 | 33.01 |
| white 5 dB | 2.04 | 4.51 | 10.99 |
| HVAC 5 dB | 2.75 | 3.08 | 8.41 |
| music 5 dB | 0.06 | -0.09 | 5.09 |
| 60 Hz hum 10 dB | 2.38 | 2.36 | 9.97 |
| 50 Hz hum 10 dB | 3.08 | 2.99 | 9.89 |

On clean recorded speech DeepFilterNet3 changes level by -0.29 dB and the
4-12 kHz band by -0.42 dB (default chain: -1.68 dB and -0.97 dB). Speed in
Node, WASM, one thread: 12.2x real time (default chain 12.4x).

On the gate's synthetic fixtures it is far worse than either chain (pinned as
the `enhance` profile, regressions only): clean synthetic speech -3.88 dB
SI-SDR, whispered synthetic speech -13.90 dB SI-SDR with its level cut by
23.6 dB, fricatives cut by up to 33 dB, every improvement-tier pair below
0 dB (pins as of the 2026-11-10 pre-roll; they were -3.01, -13.07 and 21.1 dB
while the cold start leaked the first second). Noise-only suppression is
43.08 dB. The synthetic talker is a formant buzz,
not speech, and the network treats it as noise; the recorded numbers above
are the evidence for shipping it, and they include no whispered recordings.
Do not describe it as whisper-safe, and do not make it the default from these
numbers alone.

### Pre-roll (2026-11-10)

libDF starts its ERB / unit norms and the GRUs cold, so the opening second of
every file was enhanced with transient state: speech that starts at t = 0 lost
up to 44 dB in its first 5 ms, and the opening second of the synthetic
fixtures leaked through almost untouched. `runDeepFilterNet` now enhances a
0.5 s mirrored lead-in first and discards it (`opts.preRoll`, default
`PRE_ROLL` = 24000 samples; `preRoll: 0` is exact libDF and is what the libdf
reference test runs). Corpus eval (`corpus-eval.cjs --chain enhance`, 36
recorded clips), mean SI-SDR change: whispered +8.77 dB, quiet +5.02, clean
+1.12, HVAC +0.21, babble +0.16, street -0.01, field +0.01; worst single clip
-2.16 dB (ms-snsd-clean-004, 34.25 -> 32.09 dB). On the gate's synthetic
fixtures the leak is gone, so the enhance pins moved down: whispered
synthetic speech in white 10 dB -9.42 -> -19.08 dB SI-SDR delta (main kept
the first second at -3.4 dB vs the reference and seconds 2-6 at -14 to
-31 dB; now the first second is treated like the rest), clean synthetic
-3.01 -> -3.88 dB. Noise-only suppression 42.46 -> 43.08 dB. The
`librispeech-overlap-*` corpus clips do not contain speech: all four
mixtures (and the 001 target, the one checked) are steady harmonic tone
sequences with a click about once a second, not LibriSpeech utterances, so
DeepFilterNet3 removing them (-11 to -18 dB SI-SDR out) is not a
dropped-speech defect. The clips need re-provisioning before the
overlapping-speakers class means anything.

## Re-running the recorded-speech check locally

Download a few LibriSpeech FLAC files (for example from the Hugging Face
dataset `Narsil/asr_dummy`), convert with
`ffmpeg -i x.flac -ac 1 -ar 48000 -f f32le x.f32`, and feed them through
`createMlWorker().separate()` mixed with the noise generators in
`signals.cjs`. Keep the audio out of the repository.
