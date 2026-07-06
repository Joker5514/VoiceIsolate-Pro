# Reimagine Plan — Multi-Frame Model Separation (v25 candidate)

> **Status: PROPOSAL / NOT IMPLEMENTED.** This is a reviewable design, not a
> shipped change. No frozen architecture has been touched. Nothing here may be
> merged without an explicit product decision and a follow-up implementation PR
> per phase. It exists so the "reimagine" can be evaluated before any code moves.

Authored as the design half of the modernization pass that shipped the safe
hardening fixes (CVE pins, `validate.js` `public/lib/` scan, doc reconciliation,
lint-to-zero). Those were applied; **this is deliberately deferred to planning.**

---

## 1. The ceiling we want to lift

`ARCHITECTURE.md` and `CLAUDE.md §4` both name the constraint: the shipped models
(`rnnoise_suppressor.onnx`, `bsrnn_vocals.onnx`) are **single-frame spectral-mask**
networks. Their inference contract (`src/core/ModelManifest.js`) is:

```
input  'input'  float32 [batch, 2049]   STFT magnitude frames (fft 4096, hop 1024, Hann, 48 kHz)
output 'output' float32 [batch, 2049]   sigmoid mask in [0,1] → multiplied into the complex spectrum → iSTFT
```

Each frame is masked **independently**. That caps quality: no temporal context,
fixed window, and magnitude-only masking leaves phase untouched (musical-noise /
"smearing" artifacts on transients and reverb tails). The mature separation
families — **DeepFilterNet** (denoise), **MDX-Net** / **BS-Roformer** (vocals) —
all consume a *multi-frame* context window and many also predict a *complex*
mask, which is exactly the headroom we're missing.

## 2. What MUST stay true (non-negotiable invariants)

Any model upgrade has to land **inside** the existing architecture, not around
it. From `CLAUDE.md`:

| Invariant | Why it holds here |
|---|---|
| **Phase 1 offline / Phase 2 live-mix split** | New models still run **once per file** in `MLWorker`. Sliders never re-trigger inference. |
| **No microphone, ever** | Inference input is the decoded file buffer. `Permissions-Policy: microphone=()` stays. |
| **No CDN** | New `.onnx`/wasm fetched same-origin from `/app/models/`; ORT stays `/lib/ort.min.js`. |
| **SHA-256 integrity** | Every new model gets a pinned `sha256` in `ModelManifest.js`, verified before session creation. `null` hash is dev-only. |
| **Stems output contract** | Inference still emits a **clean stem**; the **noise stem** stays the sample-wise residual `input − clean`. Transferable `Float32Array`s. |
| **4-layer purity** | Math stays in `src/core/`, execution in `src/workers/`, orchestration in `src/pipeline/`. No upward imports. |
| **AudioParam-only sliders** | The live-mix graph is unchanged; this is a Phase-1 swap only. |

If a candidate model can't satisfy all of these, it is rejected regardless of
its benchmark numbers.

## 3. The manifest already anticipates this

`src/core/ModelManifest.js` is not single-frame by assumption — it carries a
`strategy` discriminator and already scaffolds the two strategies a multi-frame
upgrade needs, both currently `sha256: null` placeholders:

- `demucs` → `strategy: 'waveform'` (raw-waveform separation, 44.1 kHz)
- `bsrnn_complex` → `strategy: 'complex-spectrogram'` (4-D complex tensor I/O)

So the reimagine is **mostly additive**: add a strategy implementation in the
worker, add a hash-pinned manifest entry, and route to it — *not* a rewrite of
the pipeline. The single-frame `spectral-mask` path stays as the always-available
fallback.

## 4. Candidate models

| Task | Candidate | Format | Strategy | Notes |
|---|---|---|---|---|
| Denoise | **DeepFilterNet 2/3** | ONNX INT8 | new `deep-filter` (complex, multi-frame) | ERB + deep filtering; strong on non-stationary noise. |
| Vocals | **MDX-Net** | ONNX INT8 | extend `spectral-mask` → multi-frame, or `complex-spectrogram` | Proven separation; large context window. |
| Vocals (stretch) | **BS-Roformer** | ONNX | `complex-spectrogram` | SOTA quality, heaviest; WebGPU-gated. |
| VAD | **Silero VAD** (keep) | ONNX fp32/int8 | `vad` | Already shipped; unchanged. |

INT8 first: smaller download (the "100% local" promise means the user pays the
bytes), faster WASM fallback, WebGPU when available.

## 5. Phased rollout (each phase is its own PR, independently revertible)

**Phase 0 — Harness (no model swap).** Generalize `MLWorker`'s overlap-add to a
multi-frame context window (`contextFrames` from the manifest entry) and add a
`strategy` dispatch seam. Drive it with the *existing* single-frame models by
setting `contextFrames: 1` — output must be **bit-identical** to today. Pure
refactor, fully covered by current tests + a new golden-output test.

**Phase 1 — Complex masking on a known model.** Export `bsrnn_vocals` to its
complex-spectrogram variant (`scripts/export_bsrnn_onnx.py` already targeted by
the `bsrnn_complex` placeholder), pin its hash, implement `complex-spectrogram`,
and gate it behind an explicit Maximum-Isolation opt-in. A/B against the
single-frame mask on a fixed clip set.

**Phase 2 — DeepFilterNet denoise.** Add the `deep-filter` strategy + INT8
entry; chain it after vocals in the existing `modelIds: string[]` Maximum-Isolation
chain (vocals → denoise) that `MLWorker` already supports. Noise stem stays the
residual against the *original* input.

**Phase 3 — MDX-Net / BS-Roformer (stretch).** WebGPU-preferred, WASM-fallback
with a size/latency budget check; auto-downgrade to Phase-1 path when the
execution provider or memory budget can't support it.

## 6. Validation & rollback

- **Integrity:** `pnpm models:validate` + `scripts/validate-onnx-models.js`; hash
  pinned in the manifest; `MLWorker` refuses a mismatch. No `null` hash ships.
- **Structural:** `pnpm validate` must stay green (no live-mic, no CDN, layer
  purity, both legacy invariants intact).
- **Correctness:** new golden-spectrogram tests per strategy; Phase-0 requires
  bit-identical output for `contextFrames: 1`.
- **Perf budget:** decode→stems wall-clock and peak memory measured per model on
  WebGPU and WASM; a model that blows the budget stays opt-in, never default.
- **Rollback:** every phase is additive behind a strategy/opt-in; reverting a
  phase is deleting its manifest entry + dispatch arm. The single-frame
  `spectral-mask` path is never removed.

## 7. Explicitly out of scope

- The removed live-microphone pipeline — **not** revived.
- Any server-side audio processing — audio never leaves the device.
- Touching the live-mix graph, sliders, or `public/app/` legacy shell.
- Auth/licensing changes.

## 8. Decision needed before any implementation

1. Is INT8-first acceptable for v25, or do we want fp32 quality first and quantize
   later?
2. Vocals: extend `spectral-mask` to multi-frame, or jump straight to
   `complex-spectrogram`?
3. Download-size budget per model (drives WebGPU-only vs. universal availability).

Until these are answered and a per-phase PR is opened and reviewed, **no code in
this plan should be written.**
