#!/usr/bin/env python3
"""
Pin SAM-Audio weights into services/sam-audio/weights.lock.json.

  pnpm sam:pin                          # default model, latest main commit
  pnpm sam:pin -- --model facebook/sam-audio-base --revision <commit>

Needs Meta's gated access on Hugging Face (HF_TOKEN or `hf auth login`).

Every file is downloaded at one fixed commit and checked against the Hub's own
metadata before it is pinned: LFS files against the Hub's sha256, small files
against their git blob id. A file that does not match is never written to the
lock. The worker then refuses any later bytes that differ from the pin.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SAM_DIR = os.path.join(HERE, "..", "services", "sam-audio")
sys.path.insert(0, SAM_DIR)

from weights_integrity import LOCK_PATH, git_blob_sha1, load_lock, sha256_file  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", default=os.environ.get("SAM_AUDIO_MODEL", "facebook/sam-audio-small"))
    ap.add_argument("--revision", default="main", help="branch, tag or commit to pin (resolved to a commit)")
    ap.add_argument("--lock", default=LOCK_PATH)
    args = ap.parse_args()

    from huggingface_hub import HfApi, snapshot_download  # type: ignore

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    info = HfApi().model_info(args.model, revision=args.revision, files_metadata=True, token=token)
    commit = info.sha
    siblings = [s for s in (info.siblings or []) if not s.rfilename.startswith(".")]
    if not commit or not siblings:
        print(f"[sam-pin] {args.model}@{args.revision}: no commit or no files (gated access?)", file=sys.stderr)
        return 1

    local = snapshot_download(
        repo_id=args.model,
        revision=commit,
        allow_patterns=[s.rfilename for s in siblings],
        token=token,
    )

    files = {}
    for s in siblings:
        path = os.path.join(local, s.rfilename)
        digest = sha256_file(path)
        if s.lfs is not None:
            expected = getattr(s.lfs, "sha256", None) or (s.lfs.get("sha256") if isinstance(s.lfs, dict) else None)
            ok = expected == digest
        else:
            expected = s.blob_id
            ok = expected == git_blob_sha1(path)
        if not ok:
            print(f"[sam-pin] REFUSED {s.rfilename}: local bytes do not match Hub metadata", file=sys.stderr)
            return 1
        files[s.rfilename] = digest
        print(f"[sam-pin] {s.rfilename} {digest}")

    lock = load_lock(args.lock)
    lock["models"][args.model] = {"revision": commit, "files": dict(sorted(files.items()))}
    with open(args.lock, "w", encoding="utf-8") as f:
        json.dump(lock, f, indent=2)
        f.write("\n")
    print(f"[sam-pin] pinned {args.model}@{commit} ({len(files)} files) -> {os.path.relpath(args.lock)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
