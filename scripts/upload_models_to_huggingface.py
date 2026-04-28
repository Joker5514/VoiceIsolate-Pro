"""
# ===== FILE: scripts/upload_models_to_huggingface.py =====

Upload the three exported ONNX models to the HuggingFace dataset repo
Joker5514/models and generate a manifest_sha256_patch.json for the app.

Authentication: HF_TOKEN must be set in the environment.
No token is ever printed or logged.
"""

import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Optional

import requests
from tqdm import tqdm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

OUTPUT_DIR = Path("./models_output")
REPO_ID = "Joker5514/models"
REPO_TYPE = "dataset"
HF_CDN_BASE = f"https://huggingface.co/datasets/{REPO_ID}/resolve/main"

# Models to upload: (local filename, repo filename, manifest key)
MODELS = [
    ("rnnoise_suppressor.onnx",  "rnnoise_suppressor.onnx",  "rnnoise"),
    ("demucs_v4_quantized.onnx", "demucs_v4_quantized.onnx", "demucs_v4"),
    ("bsrnn_vocals.onnx",        "bsrnn_vocals.onnx",        "bsrnn_vocals"),
]

MAX_RETRIES = 3
BACKOFF_BASE = 2  # seconds; retry delays: 2s, 4s, 8s


def sha256_file(path: Path) -> str:
    """Compute SHA-256 hex digest of a local file."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def retry_with_backoff(fn, label: str):
    """
    Call fn() up to MAX_RETRIES times with exponential backoff on failure.
    Raises the last exception if all retries are exhausted.
    """
    last_exc = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            wait = BACKOFF_BASE ** attempt  # 2, 4, 8 seconds
            log.warning(
                "[%s] Attempt %d/%d failed: %s. Retrying in %ds ...",
                label, attempt, MAX_RETRIES, exc, wait,
            )
            time.sleep(wait)
    raise last_exc


def ensure_repo_exists(api) -> None:
    """Create the dataset repo if it does not exist yet."""
    try:
        api.repo_info(repo_id=REPO_ID, repo_type=REPO_TYPE)
        log.info("Repo already exists: %s", REPO_ID)
    except Exception:
        log.info("Creating repo: %s (type=%s, public)", REPO_ID, REPO_TYPE)
        api.create_repo(
            repo_id=REPO_ID,
            repo_type=REPO_TYPE,
            private=False,
            exist_ok=True,
        )
        log.info("Repo created.")


def upload_file(api, local_path: Path, repo_filename: str) -> None:
    """Upload a single file with retry logic."""

    def _upload():
        api.upload_file(
            path_or_fileobj=str(local_path),
            path_in_repo=repo_filename,
            repo_id=REPO_ID,
            repo_type=REPO_TYPE,
        )

    retry_with_backoff(_upload, label=f"upload:{repo_filename}")
    log.info("Uploaded: %s -> %s/%s", local_path.name, REPO_ID, repo_filename)


def verify_cdn_url(url: str) -> bool:
    """
    Send a HEAD request with an Origin header to verify the file is accessible
    and that CORS allows the browser app to fetch it.
    Returns True if status is 200 and access-control-allow-origin is present.
    """
    headers = {"Origin": "https://voiceisolate.pro"}
    try:
        resp = requests.head(url, headers=headers, timeout=30, allow_redirects=True)
        cors_ok = "access-control-allow-origin" in resp.headers
        status_ok = resp.status_code == 200
        return status_ok and cors_ok
    except Exception as exc:
        log.error("CDN verification request failed for %s: %s", url, exc)
        return False


def main() -> None:
    start = time.time()
    log.info("=== upload_models_to_huggingface.py START ===")

    # ---- Auth check (never print the token) ----
    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        raise EnvironmentError(
            "Set HF_TOKEN environment variable before running this script."
        )
    log.info("HF_TOKEN found in environment (not logged).")

    # ---- Install huggingface-hub if needed ----
    try:
        from huggingface_hub import HfApi
    except ImportError:
        import subprocess, sys
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "huggingface-hub>=0.22.0"],
            stdout=subprocess.DEVNULL,
        )
        from huggingface_hub import HfApi

    api = HfApi(token=hf_token)
    ensure_repo_exists(api)

    manifest: dict = {}
    results: list[tuple[str, bool]] = []  # (label, passed)

    with tqdm(MODELS, desc="Processing models", unit="model") as pbar:
        for local_name, repo_name, manifest_key in pbar:
            pbar.set_postfix(model=local_name)
            local_path = OUTPUT_DIR / local_name
            cdn_url = f"{HF_CDN_BASE}/{repo_name}"

            # ---- Check local file exists ----
            if not local_path.exists():
                log.warning("SKIP: %s not found locally.", local_path)
                results.append((f"upload:{local_name}", False))
                results.append((f"cdn:{local_name}", False))
                continue

            # ---- SHA-256 before upload ----
            digest = sha256_file(local_path)
            log.info("Pre-upload SHA-256 [%s]: %s", local_name, digest)

            # ---- Upload with retry ----
            upload_ok = True
            try:
                upload_file(api, local_path, repo_name)
            except Exception as exc:
                log.error("Upload failed after retries: %s — %s", local_name, exc)
                upload_ok = False

            results.append((f"upload:{local_name}", upload_ok))

            if not upload_ok:
                results.append((f"cdn:{local_name}", False))
                continue

            # ---- CDN CORS verification ----
            log.info("Verifying CDN URL: %s", cdn_url)
            # HuggingFace CDN may take a moment to propagate
            time.sleep(3)
            cdn_ok = verify_cdn_url(cdn_url)
            results.append((f"cdn:{local_name}", cdn_ok))

            manifest[manifest_key] = {
                "sha256": digest,
                "cdn_src": cdn_url,
            }

    # ---- Print verification summary ----
    print("\n--- Verification Results ---")
    for label, passed in results:
        symbol = "✓" if passed else "✗"
        print(f"  {symbol}  {label}")

    # ---- Write manifest patch file ----
    manifest_path = OUTPUT_DIR / "manifest_sha256_patch.json"
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    log.info("Manifest written: %s", manifest_path)

    elapsed = time.time() - start
    log.info("=== upload_models_to_huggingface.py DONE in %.1fs ===", elapsed)

    # ---- Final instruction block (plain print, not logging) ----
    print("""
============================================================
NEXT STEP: Update public/app/models/models-manifest.json
Copy the sha256 values from ./models_output/manifest_sha256_patch.json
into the "sha256" fields for rnnoise, demucs_v4, and bsrnn_vocals.
============================================================
""")


if __name__ == "__main__":
    main()
