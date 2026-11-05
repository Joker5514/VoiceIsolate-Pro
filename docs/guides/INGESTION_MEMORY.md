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

At 75% of budget the UI warns and continues. Above budget it refuses with `INGESTION_BUDGET_EXCEEDED`; unknown metadata refuses with `INGESTION_METADATA_REQUIRED`. Errors suggest a shorter excerpt, mono export, or more capable device. The app never silently truncates or downsamples to fit.

## Verification status

Node tests cover WAV metadata, tier decisions, soft/hard boundaries, unknown/malformed metadata, cancellation and post-decode channel expansion. Browser/device memory behavior, compressed-container metadata accuracy and long-file capture ceilings are **not yet device-verified**.
