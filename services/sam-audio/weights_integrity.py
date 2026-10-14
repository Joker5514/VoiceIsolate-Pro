"""
SAM-Audio weight integrity (VoiceIsolate Pro local worker).

weights.lock.json pins, per model id, the Hugging Face commit and the SHA-256
of every file the worker loads:

  {
    "schema": 1,
    "models": {
      "facebook/sam-audio-small": {
        "revision": "<40-hex commit>",
        "files": { "config.json": "<sha256>", "model.safetensors": "<sha256>" }
      }
    }
  }

The worker downloads exactly that revision and those files, hashes them, and
refuses to load on any mismatch. Pins are written by scripts/sam-pin-weights.py,
which checks each local file against the Hub's own metadata (LFS sha256, or the
git blob id for small files) before trusting it. No hash is ever hand-written.

Stdlib only, so it can be imported and tested without torch or sam_audio.
"""
from __future__ import annotations

import hashlib
import json
import os
from typing import Any, Dict, Optional

LOCK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "weights.lock.json")
_HEX40 = set("0123456789abcdef")
# Files the worker's loader reads (sam_hub_compat: config.json + checkpoint.pt).
REQUIRED_FILES = ("config.json", "checkpoint.pt")


class WeightsIntegrityError(RuntimeError):
    """Weights are unpinned (when pins are required) or do not match their pin."""


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_blob_sha1(path: str) -> str:
    """Git object id of a file (what the Hub reports as blob_id for non-LFS files)."""
    h = hashlib.sha1()
    h.update(f"blob {os.path.getsize(path)}\0".encode())
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_lock(path: str = LOCK_PATH) -> Dict[str, Any]:
    if not os.path.exists(path):
        return {"schema": 1, "models": {}}
    with open(path, "r", encoding="utf-8") as f:
        lock = json.load(f)
    if lock.get("schema") != 1 or not isinstance(lock.get("models"), dict):
        raise WeightsIntegrityError(f"unsupported weights lock: {path}")
    return lock


def pin_for(model_id: str, lock: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    entry = lock.get("models", {}).get(model_id)
    if entry is None:
        return None
    rev = str(entry.get("revision", ""))
    files = entry.get("files")
    if len(rev) != 40 or not set(rev) <= _HEX40:
        raise WeightsIntegrityError(f"{model_id}: pin needs a 40-hex commit revision")
    if not isinstance(files, dict) or not files:
        raise WeightsIntegrityError(f"{model_id}: pin lists no files")
    missing = [f for f in REQUIRED_FILES if f not in files]
    if missing:
        raise WeightsIntegrityError(f"{model_id}: pin must list {', '.join(missing)}")
    for name, digest in files.items():
        d = str(digest)
        if os.path.isabs(name) or ".." in name.replace("\\", "/").split("/"):
            raise WeightsIntegrityError(f"{model_id}: unsafe file name in pin: {name}")
        if len(d) != 64 or not set(d) <= _HEX40:
            raise WeightsIntegrityError(f"{model_id}: {name} has no valid sha256 pin")
    return entry


def verify_snapshot(model_id: str, local_dir: str, entry: Dict[str, Any]) -> Dict[str, Any]:
    """
    Hash every pinned file under local_dir; raise on a missing or changed file,
    or on any unpinned (non-hidden) file a warm cache could slip to the loader.
    """
    for root, dirs, names in os.walk(local_dir):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for n in names:
            rel = os.path.relpath(os.path.join(root, n), local_dir).replace(os.sep, "/")
            if not n.startswith(".") and rel not in entry["files"]:
                raise WeightsIntegrityError(f"{model_id}: unpinned file in snapshot: {rel}")
    for name, expected in entry["files"].items():
        path = os.path.join(local_dir, name)
        if not os.path.isfile(path):
            raise WeightsIntegrityError(f"{model_id}: pinned file missing: {name}")
        actual = sha256_file(path)
        if actual != expected:
            raise WeightsIntegrityError(
                f"{model_id}: {name} sha256 {actual[:12]}… does not match pin {expected[:12]}…"
            )
    return {"pinned": True, "verified": True, "revision": entry["revision"], "files": len(entry["files"])}


def resolve_weights(
    model_id: str,
    *,
    token: Optional[str],
    require_pin: bool,
    lock: Optional[Dict[str, Any]] = None,
    download=None,
) -> tuple[str, Dict[str, Any]]:
    """
    Returns (from_pretrained source, integrity report).

    Pinned: downloads exactly the pinned revision/files, verifies them, returns
    the local snapshot dir. Unpinned: refuses when require_pin, otherwise
    returns the bare model id (unverified, reported as such).
    """
    lock = load_lock() if lock is None else lock
    entry = pin_for(model_id, lock)
    if entry is None:
        if require_pin:
            raise WeightsIntegrityError(
                f"weights-unpinned: {model_id} has no entry in weights.lock.json; "
                "run pnpm sam:pin (or set SAM_AUDIO_ALLOW_UNPINNED=1 to accept unverified weights)"
            )
        return model_id, {"pinned": False, "verified": False}
    if download is None:
        from huggingface_hub import snapshot_download  # type: ignore

        download = snapshot_download
    local_dir = download(
        repo_id=model_id,
        revision=entry["revision"],
        allow_patterns=list(entry["files"].keys()),
        token=token,
    )
    return local_dir, verify_snapshot(model_id, local_dir, entry)
