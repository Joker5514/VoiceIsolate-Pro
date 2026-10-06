# Audit probes (2026-10-06)

Evidence for `docs/audits/MASTER_AUDIT_2026-10-06.md`. Run from the repository root after `pnpm install`. All inputs are generated deterministically inside each script (fixed LCG seed 1 for noise). Not part of CI.

| Script | Report section | Expected output at `49d517e` |
|---|---|---|
| `node scripts/audit/2026-10-06/dsp-probe.cjs` | AUD-003, AUD-004 | `removeClicks` modifies 4112 of 96000 samples; sibilant RMS 0.1207 -> 0.0931; voiced error 0.00000. `deEss` 200 Hz gain -2.04 dB; 6.5 kHz gain -1.43 dB |
| `node scripts/audit/2026-10-06/dsp-timing.cjs` | PERF-001 | per-pass ms on 300 s mono (machine-dependent; audit container: removeClicks 1488, deEss 167, noiseGate 157, removeDCOffset 61) |
| `node scripts/audit/2026-10-06/ort-bench.mjs` | section 7 | sha256 `7edd7c51...8141`; mask range [0.000, 1.000]; ms/frame machine-dependent (audit container: 0.287) |
| `node scripts/audit/2026-10-06/ort-temporal-context.mjs` | section 7 | both deltas `0.00e+0` for both models |
