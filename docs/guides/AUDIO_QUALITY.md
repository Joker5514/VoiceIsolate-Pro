# Audio quality measurement

VoiceIsolate Pro measures separation quality objectively. Nothing here is a
listening test; it pins the shipped signal path so a change that makes the
audio worse fails a gate instead of shipping.

## Commands

| Command | What it does | Runtime |
|---|---|---|
| `pnpm test:quality` | Gate: 9 fixtures x 3 profiles through the production `MLWorker.js` with the shipped ONNX models; hard invariants plus 45 pinned metrics (SI-SDR, speech level, noise reduction). Also `prod:verify` step `audio-quality`. | about 30 s |
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
hard clipping, silence. Every scenario knows its ground-truth target.

These are proxies. They catch regressions in the shipped path; they do not
certify absolute quality on recorded speech. Recorded-speech evidence for
calibration changes is gathered locally (see below) and is not committed.

## Metrics

| Metric | Meaning |
|---|---|
| SI-SDR | Scale-invariant SDR of the clean stem against the dry target (dB). Used as absolute preservation for clean inputs. |
| SI-SDR delta | SI-SDR(output) minus SI-SDR(input). Positive means the output is closer to the target than the input was. |
| noise-reduction | RMS of a noise-only input minus RMS of its clean stem (dB). |
| level, HF 4-12 kHz, fricative, gap leak | Matrix only: level change in speech, high-band change in speech, energy change on fricative onsets, residual in pauses. |

Hard invariants in the gate: no NaN or Infinity, length preserved, digital
silence in gives peak below 1e-6 out, no output sample above full scale.

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

## Re-running the recorded-speech check locally

Download a few LibriSpeech FLAC files (for example from the Hugging Face
dataset `Narsil/asr_dummy`), convert with
`ffmpeg -i x.flac -ac 1 -ar 48000 -f f32le x.f32`, and feed them through
`createMlWorker().separate()` mixed with the noise generators in
`signals.cjs`. Keep the audio out of the repository.
