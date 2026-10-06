# Audit probes (2026-10-06)

Evidence for `docs/audits/MASTER_AUDIT_2026-10-06.md`. Run from the repository root after `pnpm install`. All inputs are generated deterministically inside each script (fixed LCG seed 1 for noise). Not part of CI. `dsp-sibilant-probe.cjs`, `dsp-probe.cjs` and `ort-temporal-context.mjs` accept `--check`, which exits non-zero if the reported values no longer hold. All audio fixtures are synthetic, not recorded speech. `dsp-sibilant-probe.cjs` is the primary click-repair test (band-limited, ramped burst plus an injected-click control); `dsp-probe.cjs` uses a cruder hard-edged noise burst.

| Script | Report section | Expected output at `49d517e` |
|---|---|---|
| `node scripts/audit/2026-10-06/dsp-sibilant-probe.cjs` | AUD-003 | 3739 samples changed in the 4-9 kHz burst, 0 elsewhere; burst -1.45 dB; control 5/5 clicks repaired |
| `node scripts/audit/2026-10-06/dsp-probe.cjs` | AUD-003, AUD-004 | `removeClicks` modifies 4112 of 96000 samples; sibilant RMS 0.1207 -> 0.0931; voiced error 0.00000. `deEss` 200 Hz gain -2.04 dB; 6.5 kHz gain -1.43 dB |
| `node scripts/audit/2026-10-06/dsp-timing.cjs` | PERF-001 | median of 5 warmed runs per pass on 300 s mono (machine-dependent; audit container: removeClicks 1180, noiseGate 155, deEss 149, removeDCOffset 52 ms) |
| `node scripts/audit/2026-10-06/ort-bench.mjs` | section 7 | sha256 `7edd7c51...8141`; mask range [0.000, 1.000]; ms/frame machine-dependent (audit container: 0.287) |
| `node scripts/audit/2026-10-06/ort-temporal-context.mjs` | section 7 | both deltas `0.00e+0` for both models |
