# Real-recording quality corpus (VIP-006) — schema & loader

**Status:** framework delivered; corpus audio **not provisioned** (licensing +
sandbox egress). This directory defines how real recordings enter the quality
program without ever committing copyrighted audio to git.

## Why a manifest + external storage

`scripts/quality/quality-gate.cjs` runs synthetic fixtures only ("proxies" per
`docs/guides/AUDIO_QUALITY.md`). Real-recording evidence needs recorded speech,
but:

- copyrighted/restricted audio must **never** enter the repository (CLAUDE.md
  rules + this repo's license policy);
- large binaries stay out of git (repo convention: external storage).

So a corpus is **externally provisioned** and admitted only with license +
checksum records. `load-corpus.mjs` refuses anything undocumented.

## Directory layout

```
<corpus-root>/
  corpus-manifest.json      # the only file that may live in git
  audio/                    # externally provisioned; git-ignored
    <clip-id>.wav
    …
```

## corpus-manifest.json schema (v1)

```jsonc
{
  "schema": "vip-quality-corpus",
  "schemaVersion": 1,
  "datasetVersion": "2026-11-02.a",        // reported by every run
  "licensePolicy": "CC0-1.0-or-published-with-granted-redistribution",
  "clips": [
    {
      "id": "librispeech-f-clean-001",      // stable id, also the filename stem
      "path": "audio/librispeech-f-clean-001.wav",
      "sha256": "<64-hex>",                // REQUIRED — loader verifies bytes
      "source": "LibriSpeech test-clean",   // provenance of the recording
      "license": "CC BY 4.0",               // per-clip license
      "attribution": "…",                   // required by the license, if any
      "redistribution": "allowed",          // allowed | private-only
      "category": "clean-speech",           // see categories below
      "language": "en",
      "sampleRate": 16000,
      "channels": 1,
      "durationSec": 8.2,
      "levelDbfs": -23,                     // measured average, informational
      "reference": {                        // optional: metrics that need one
        "alignedTargetPath": "audio/librispeech-f-clean-001-target.wav",
        "alignedTargetSha256": "<64-hex>",
        "alignment": "sample-accurate"      // sample-accurate | approximate | none
      },
      "notes": ""
    }
  ]
}
```

**Categories (at least four noise classes required by the acceptance bar):**
`clean-speech`, `quiet-speech`, `whispered-speech`, `noisy-speech/white`,
`noisy-speech/hvac`, `noisy-speech/hum`, `noisy-speech/babble`,
`noisy-speech/street`, `overlapping-speakers`, `music-with-vocals`,
`field-recording`. Clips may carry extra `tags: []` for sub-groupings.

**Metric eligibility (loader-derived, never hand-claimed):**
- `SI-SDR/SDR/SIR/SAR` — only when `reference.alignedTargetPath` exists and
  `alignment === 'sample-accurate'`.
- `STOI/ESTOI/PESQ` — same alignment requirement, plus licensing of the
  *tooling* (PESQ reference implementations carry their own terms — record the
  tool version in `tools/` before use).
- `WER` — requires a documented offline ASR (name + version + decoding params
  pinned in the run report). None is bundled yet: **missing dependency**.
- `speech-level / HF-energy / fricative-preservation / runtime / peak-memory /
  artifact-listening` — valid for every clip without a reference.

## Loader

```
node scripts/quality/load-corpus.mjs --root <corpus-root> [--json out.json]
```

- validates the manifest against the schema;
- **verifies every clip's SHA-256** (mismatch ⇒ hard failure);
- refuses clips with missing/`private-only` redistribution records unless
  `--allow-private` (local-only runs);
- reports `datasetVersion`, per-category counts, metric eligibility, and any
  schema gaps;
- exits non-zero on any violation — a corpus that cannot prove its licenses
  and bytes does not enter the quality program.

## Provisioning checklist (owner action)

1. Collect recordings under licenses that permit this use; keep evidence.
2. Transcode to WAV (record the transcode in `notes`).
3. Measure level/duration (any tool; record values in the manifest).
4. Compute SHA-256 per file, fill `corpus-manifest.json`.
5. `node scripts/quality/load-corpus.mjs --root <dir>` must exit 0.
6. Keep `audio/` out of git (git-ignored by convention).

**Missing dependency (honest):** ≥30 real clips across ≥4 noise classes with
verified redistribution rights have NOT been assembled in this environment
(no network egress to dataset hosts, no licensed recordings available). The
`test:quality:real` command will wrap `load-corpus.mjs` + the metrics above as
soon as a corpus root passes the loader.
