# Corpus evaluation guide (VIP-004 / VIP-034)

## Run it

```sh
node scripts/quality/corpus-eval.cjs            # full eval (36 clips × 4 chains)
node scripts/quality/corpus-eval.cjs --stems    # also write blinded listening pairs
node scripts/quality/corpus-eval.cjs --clip <id> --chain <id>  # subset (debugging)
```

Output (git-ignored): `output/corpus-eval/report.json` (every run) and
`report.md` (per-class means, worst cases, threshold verdicts). With
`--stems`, `output/corpus-eval/listen/` holds the blinded pairs plus
the sealed key.

Runtime is roughly 10–15 minutes on a VM-class machine (WASM, single
thread, deterministic). The script exits 1 on missing or
checksum-mismatched assets, invariant failures, or crashes — an
incomplete eval never reports as passed.

## What the numbers mean

- **Noisy / field / overlap clips (22):** scored against a separate
  aligned clean target. SI-SDR delta is the headline: output quality
  minus input quality. Overlap targets are the primary speaker.
- **Clean / quiet / whispered clips (14):** the target is the clip
  itself, so the headline is **preservation** (SI-SDR of output against
  the input). A chain that "improves" clean speech by changing it is
  distorting it.
- **Speech-level delta** (active frames only) catches the failure SI-SDR
  forgives: a chain that makes speech quieter. **Fricative delta**
  (3.5–9 kHz band, active frames) catches mask damage to sibilants.
- **Plain SDR** is reported beside SI-SDR because SI-SDR forgives
  overall gain and SDR does not.
- **Warm RTF** excludes model load; **cold start** is worker init plus
  the first model load per chain. The enhance chain runs ungated here
  for measurement; in product it is gated by EnhanceGuard.

## Thresholds and selection

Thresholds live in `docs/guides/CORPUS_THRESHOLDS.md` and were written
before the first eval ran. The report judges each chain mechanically
against them; a chain that meets all bars is *eligible* for selection,
not automatically selected. Selection stays a product decision, and no
chain is promoted on a single clip, a single class, or synthetic
fixtures.

## Known gaps (not hidden)

- **PESQ / STOI:** no validated implementation bundled. Objective
  metrics plus blinded listening (see `docs/guides/
  LISTENING_RUBRIC.md`) are the perceptual cover instead.
- **WER:** no pinned offline ASR bundled (the #885 ledger already
  records this as the missing dependency).
- **Future models:** a new model (SCNet, BS-RoFormer, or any deferred
  Phase 3 candidate) is evaluated by adding it as a chain here, on the
  same clips and protocol, and comparing against this report — never
  against a different protocol.
