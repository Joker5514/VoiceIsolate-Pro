# Ingestion memory budget (VIP-009)

VoiceIsolate decodes locally. A compressed file's byte size is **not** its decoded memory cost. Before the Landing or Engineer decode path allocates PCM, `IngestionPreflight` reads at most 1 MiB of header data and plans against `src/core/IngestionBudget.js`.

## Estimate

- WAV/RF64: parse `fmt ` and `data` for duration, channels, sample rate and bit depth. Malformed RIFF headers fail before decode.
- Other containers: metadata-only media-element duration probe. Channel count is conservatively assumed stereo until the decoded buffer is checked; sample rate falls back to 48 kHz. Unknown duration is refused, not decoded speculatively.
- Browser PCM is Float32 (4 bytes/sample/channel), regardless of source bit depth.
- Decode peak: two encoded-input copies + decoded PCM + canonical copy + extraction + any resampling copy.
- Processing peak: six canonical full-length copies (raw, clean/noise, mixer, cache/review) + one encoded source.
- The estimate is the larger phase, not the sum. After decode, the actual channel count/rate/duration is checked again before resampling/extraction. The media-capture fallback also has a hard growing-buffer ceiling.

## Device tiers

| Tier | Working budget | Reported-device-memory fraction |
|---|---:|---:|
| HIGH | 3 GiB | 37.5% |
| BALANCED | 768 MiB | 25% |
| CONSTRAINED | 256 MiB | 12.5% |

The effective budget is the smaller of the tier cap and the reported fraction. `navigator.deviceMemory` is coarse and Chromium-only; unknown memory uses the tier cap selected from the existing performance-tier signals. These are conservative planning budgets, **not** measured guarantees about browser/tab OOM limits. Real-device validation remains required.

At 75% of budget the UI warns and continues. The full-file decision stays `allow`, `warn`, or `refuse`. A `refuse` decision becomes chunked processing when the selected chain is a 48 kHz spectral-mask model and one window fits the budget. Unknown metadata still refuses with `INGESTION_METADATA_REQUIRED`. A model that keeps temporal state (DeepFilterNet, Demucs) is not split into windows. The app never silently truncates or downsamples to fit.

## Four measurements

| Measurement | What it is |
|---|---|
| Compressed size | The file on disk. Storage capacity is not RAM. |
| Decoded PCM | Float32 duration × rate × channels. |
| Ingestion peak | The larger of the decode-phase copies. |
| Processing peak | Six canonical copies plus the source file. This is the number that produced the 7,922 MiB refusal. |

The model download size and a WebGPU flag are not part of the estimate. `navigator.deviceMemory`, when present, only tightens the tier cap. The UI does not claim an exact free-RAM reading.

## Chunked strategy

`resolveIngestionPlan` keeps `decision` as the full-file verdict and adds `strategy`: `full`, `chunked`, or `refuse`. AUTO is the default profile and uses the device tier's window (HIGH 45 s, BALANCED 20 s, LOW 8 s). LOW, BALANCED, and HIGH select those lengths inside the same device budget. Each window carries model context (`max(fft, hop × 16)` for `bsrnn_vocals`, 16,384 samples) and overlaps the next core by one hop. The overlap is crossfaded. A failed or cancelled window aborts the sink.

WAV is read from the data chunk. M4A/AAC and MP3 are demuxed locally and decoded with WebCodecs when `AudioDecoder` exists. There is no media-element capture for chunked compressed audio. Oversized FLAC/OGG fail with `CHUNK_DECODER_UNAVAILABLE` instead of a shifted capture. When the clean and removed stems both fit, they stay in memory and use the existing mixer. When they do not, the extract is a 16-bit WAV and playback uses one media element.

## Verification status

Node tests cover the 7,922 MiB / 768 MiB plan, profile window lengths, the non-chunkable model refusal, WAV metadata, tier decisions, identity and gain reconstruction, a failed window, cancellation, a 16-bit WAV window, an MP4 sample table, and MP3 frame length. They do not measure speech quality on a real recording. WebCodecs decode of a real M4A, Android, Electron, and browser memory behavior are **not device-verified** in this change. GitHub Actions on this repository has been failing immediately from an account billing lock. That is not a passing check.
