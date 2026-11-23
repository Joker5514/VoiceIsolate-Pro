# Diarization speech fixtures

16 kHz mono PCM16 clips for `tests/speaker-diarizer-real-speech.test.js`. Each clip has a `.json` file with its ground-truth turns. They were built by `make_clips.py fixtures` (round 12 work dir): utterances alternate, each capped at 6 s, with 0.4 s gaps, peak-normalised to 0.5.

| Clip | Speakers | Source | License |
|------|----------|--------|---------|
| `libri_2spk_mf.wav` | 2 (1462 F, 2428 M) | LibriSpeech dev-clean, via mini LibriSpeech `dev-clean-2` (OpenSLR SLR31) | CC BY 4.0 (V. Panayotov, G. Chen, D. Povey, S. Khudanpur, "LibriSpeech", ICASSP 2015) |
| `libri_2spk_mm.wav` | 2 (251 M, 3752 M) | same | CC BY 4.0 |
| `libri_1spk_m.wav` | 1 (1272 M) | same | CC BY 4.0 |
| `osr_2talker.wav` | 2 (OSR_us_000_0010 F, OSR_us_000_0030 M) | Open Speech Repository, https://www.voiptroubleshooter.com/open_speech/american.html; 8 kHz upsampled to 16 kHz | "freely available for use in ... research, development ... may be copied ... modified"; credit: Open Speech Repository |
| `espeak_2voice.wav` | 2 (`en-us`, `en-us+f3`) | Synthesised with espeak-ng | Generated audio; no third-party recording |

Reference data:
- `silero-reference.json`: per-chunk speech probabilities and `get_speech_timestamps` segments for each clip. Produced by the official silero-vad 6.2.3 Python `OnnxWrapper` running the shipped `public/models/silero-vad.onnx`, with 512-sample chunks.
- `kaldi-fbank-reference.json`: `torchaudio.compliance.kaldi.fbank` (hamming window, 80 bins, input ×32768, no CMN) on 0.5 s of `libri_2spk_mf.wav` starting at sample 16000. This is the WeSpeaker front end.
