Golden stems for tests/perf-bundle-identity.test.js.

Generated on unpatched main (d7948c9e36170dbf8d71a60f419073e3b5e7a661) by
cropping 1.5 s at 48 kHz from echo-artifacts fixtures and running the
quality-harness ML worker (numThreads = 1).

  librispeech-clean-001  — real-librispeech-clean-001, resampled 16 kHz → 48 kHz
  syn-whisper-white-10db — 48 kHz whisper-in-noise fixture

Profiles: landing, enhance, Whisper-Boost, Surveillance.

HfPostFilter.main.js is origin/main's filter, used as the always-log10
reference so the early-out path can be compared bin-for-bin.
