# SAM-Audio setup: real weights with integrity pins

Desktop only. Web and Android have no SAM loader (see [SAM_AUDIO.md](SAM_AUDIO.md)).

## 1. Install the runtime

```bash
pnpm sam:setup        # .venv-sam, official sam-audio package, shared FFmpeg
```

## 2. Get gated access

The `facebook/sam-audio-*` checkpoints are gated on Hugging Face and approved
manually by Meta. Request access on the model page, then:

```bash
# `hf` is installed into .venv-sam by sam:setup; activate it first.
source .venv-sam/bin/activate      # Windows: .venv-sam\Scripts\activate
hf auth login
```

`hf auth login` covers both `pnpm sam:pin` and the worker. If you use
`HF_TOKEN` instead, set it for both commands: each reads it in its own
process. The token stays in the pin script, the worker and the Electron main
process. It never reaches the renderer.

## 3. Pin the weights

```bash
pnpm sam:pin                                          # SAM_AUDIO_MODEL or sam-audio-small, latest main
pnpm sam:pin -- --model facebook/sam-audio-base --revision <commit>
```

`scripts/sam-pin-weights.py`:

1. resolves the revision to one 40-hex commit;
2. downloads every non-hidden file of that commit (names starting with `.`,
   such as `.gitattributes`, are skipped, and the worker ignores them too);
3. checks each file against the Hub's own metadata: the LFS sha256 for weight
   files, the git blob id for small files;
4. requires `config.json` and `checkpoint.pt` (the files the loader reads);
5. writes the commit and each file's SHA-256 to
   `services/sam-audio/weights.lock.json` (temp file + rename), or refuses if
   anything differs.

Commit the updated lock. Nobody writes a hash by hand. The repository ships
an empty lock because the maintainers' account does not have gated access, so
no real hash could be read.

## 4. Run

```bash
pnpm sam:worker:prod   # SAM_AUDIO_PRODUCTION=1, mock blocked, --preload
# A non-default model must be named here too, or the default is used (and
# refused if it is unpinned):
SAM_AUDIO_MODEL=facebook/sam-audio-base pnpm sam:worker:prod
```

On load, `services/sam-audio/server.py` calls `resolve_weights()`
(`weights_integrity.py`):

| Lock state | Production / `SAM_AUDIO_REQUIRE_REAL` | Dev |
|---|---|---|
| Pinned, all files match | loads the verified local snapshot | same |
| Pinned, a file differs, is missing, or an unpinned file is in the snapshot | **refused** (`weights-integrity: ...`) | refused; mock may serve |
| Not pinned | **refused** (`weights-unpinned`) unless `SAM_AUDIO_ALLOW_UNPINNED=1` | loads unverified, logs a warning |

`GET /capabilities` reports the result under `weights`
(`pinned`, `verified`, `revision`, `files`, or `error`). `/ready` stays 503
while the real model is required and not loaded.

## 5. Electron proxy

The renderer never talks to the worker. `electron/sam-proxy.cjs` refuses ports
below 1024 and confirms `/health` reports `service: sam-audio-worker` before
it sends any PCM.

## Limits

- Pins prove the bytes match the Hub at a fixed commit. They do not prove that
  commit is benign; review a new revision before pinning it.
- The model loader (`sam_hub_compat`) reads `config.json` and `checkpoint.pt`
  from the verified local directory. The processor's local-directory load has
  not been exercised here with real weights (no gated access). Run `pnpm sam:pin` and `pnpm sam:worker:prod` once on a
  machine with access before relying on it.
- Desktop defaults to production mode. Real SAM stays off until the weights
  are pinned (or `SAM_AUDIO_ALLOW_UNPINNED=1` is set deliberately).
