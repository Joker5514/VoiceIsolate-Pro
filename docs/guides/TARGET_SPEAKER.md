# Target speaker ("Focus on one voice")

Enroll a short stretch where only one person talks, then isolate them: other
voices on the clean stem are turned down with a smooth per-sample gain. It runs
after Process, on an explicit click, entirely on the device.

## Two embedding paths

| | ECAPA-TDNN (optional) | Mel voiceprint (fallback) |
|---|---|---|
| Model | WeSpeaker `voxceleb_ECAPA512.onnx`, 192-D, Apache-2.0 | none (24 mel bands) |
| Install | `pnpm models:fetch-ecapa`, then `pnpm build` | built in |
| Runs in | `src/workers/SpeakerEmbeddingWorker.js` | main thread (`src/core/TargetSpeaker.js`) |
| Windows | 1.5 s, 0.5 s hop | 0.2 s, 0.05 s hop |
| Threshold | 0.35 cosine, soft width 0.08 | 0.42 cosine, soft width 0.12 |

The UI tries ECAPA first. If the model is missing, fails its SHA-256 pin, or the
worker errors, it says so in the status line and uses the mel voiceprint.

## Measurements

LibriSpeech test-clean, 10 speakers, 6 utterances each (3–10 s). Each speaker
enrolls on the first 3 s of one utterance; every window of their other five
utterances is scored against all ten enrollments.

| | EER | At its default threshold |
|---|---|---|
| ECAPA, 1.5 s windows | **1.9 %** (at 0.343) | target missed on 2.2 %, other speakers passed on 1.6 % |
| Mel, 1.5 s windows | 19.1 % (at 0.851) | other speakers passed on 96.1 % |
| Mel, 0.2 s speech windows (shipped) | 37.4 % (at 0.642) | target missed on 12.2 %, other speakers passed on 70.9 % |

Full utterances with ECAPA: EER 0.15 %. The blueprint's cosine 0.75 is a
full-utterance figure; on 1.5 s windows it rejected 95 % of target windows,
so the ECAPA default is the measured operating point instead.

Speed: about 45 ms of single-thread WASM per 1.5 s window under Node, so a
10-minute file (1,200 windows) takes about a minute single-threaded. The
browser uses SIMD and, when cross-origin isolated, threads; progress is shown.

Reproduce (needs the model installed):

```bash
pnpm models:fetch-ecapa
# <dir>/<speakerId>/*.wav, 16-bit mono (e.g. ffmpeg -i x.flac -ac 1 -ar 16000 x.wav)
node scripts/quality/speaker-eval.mjs <dir>
```

## Front end

`src/workers/SpeakerFeatures.js` reproduces Kaldi fbank as WeSpeaker trained
it: 16 kHz (windowed-sinc resample), input scaled to int16, 25 ms frames with
10 ms shift, DC removal, 0.97 pre-emphasis, povey window, 512-point power
spectrum, 80 mel bins from 20 Hz to Nyquist, log, mean normalisation per
window. `tests/speaker-features.test.js` pins it to kaldi-native-fbank within
1e-3 (log domain).

## Integrity and licensing

- `ModelManifest.ecapa_tdnn` pins the Hub commit and the file's SHA-256, which
  equals the Hub's own LFS digest. The fetch script and the worker both refuse
  any other bytes.
- The model is not committed (25 MB) and is git-ignored. To ship it to every
  user, commit it or host it at `/app/models/ecapa_tdnn.onnx` in the deploy;
  that is a size and distribution decision for the release owner.
- WeSpeaker publishes the model under Apache-2.0. It was trained on VoxCeleb2,
  whose data is CC BY 4.0; keep attribution in release notes when shipping it.

## Limits

- Isolation is a time-domain gain on the clean stem, not a mask inside the ML
  STFT. Overlapping speech of two people in the same window cannot be split.
- The mel fallback barely tells speakers apart; with it, isolation mostly
  relies on diarization fusion when diarization found several speakers.
