#!/usr/bin/env python3
"""
export_and_upload.py — VoiceIsolate Pro

Laptop-only orchestrator for the full model pipeline:

  1. Install/verify Python deps from scripts/requirements_export.txt
  2. Run the three ONNX export scripts  (models_output/<name>.onnx)
  3. Copy exported models into public/app/models/  (removes .placeholder stubs)
  4. Verify each file is non-empty and meets minimum-size thresholds
  5. Upload each model to Vercel Blob via the Vercel Blob REST API
  6. Patch vercel.json — insert/update one rewrite per model BEFORE the
     /app/((?!sw\\.js).*) catch-all; preserve all other rewrites
  7. Back-fill sha256 fields in models-manifest.json
  8. Warn if manifest references models that still lack rewrites

Usage (from the repo root):

    export VERCEL_TOKEN=vercel_...             # required
    export VERCEL_TEAM_ID=team_...             # optional (team projects only)
    python export_and_upload.py

    # Skip the slow export step if models_output/ already has the files:
    python export_and_upload.py --skip-export

    # Dry-run: no Blob upload, just re-patch vercel.json from existing rewrites:
    python export_and_upload.py --skip-export --skip-upload

    # Re-export and re-upload a single model:
    python export_and_upload.py --only rnnoise_suppressor.onnx

Environment variables (also accepted as CLI flags):
    VERCEL_TOKEN   – personal access token from vercel.com/account/tokens
    VERCEL_TEAM_ID – team slug or ID (optional)
    SKIP_EXPORT    – set to "1" to skip export (same as --skip-export)
    SKIP_UPLOAD    – set to "1" to skip upload (same as --skip-upload)

After this script finishes, commit and push:

    git add public/app/models/ vercel.json
    git commit -m "chore(models): refresh ONNX exports and Blob rewrites"
    git push origin main

Architecture note: models are served same-origin from /app/models/*.onnx.
Vercel either serves a static file (silero_vad, committed to repo) or proxies
to Vercel Blob via the rewrite added here (demucs, bsrnn, rnnoise).
The browser never sees Blob URLs — COEP stays satisfied, SharedArrayBuffer lives.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Paths — all resolved from the project root (where this script lives)
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).parent.resolve()
MODELS_OUTPUT_DIR = REPO_ROOT / 'models_output'
MODELS_PUBLIC_DIR = REPO_ROOT / 'public' / 'app' / 'models'
VERCEL_JSON = REPO_ROOT / 'vercel.json'
MANIFEST_JSON = MODELS_PUBLIC_DIR / 'models-manifest.json'
REQUIREMENTS_TXT = REPO_ROOT / 'scripts' / 'requirements_export.txt'

# ---------------------------------------------------------------------------
# Model registry
#
# 'silero_vad' is committed directly to the repo and served as a static file;
# it is NOT uploaded to Blob and needs no rewrite. Only the three models below
# go through this pipeline.
# ---------------------------------------------------------------------------

MODELS: list[dict] = [
    {
        'filename':        'rnnoise_suppressor.onnx',
        'min_bytes':       10_000,         # quantized GRU: comfortably > 10 KB
        'export_script':   REPO_ROOT / 'scripts' / 'export_rnnoise_onnx.py',
        'size_limit_label': '512 KB',
    },
    {
        'filename':        'demucs_v4_quantized.onnx',
        'min_bytes':       10_000_000,     # INT8-quantized mdx_extra: > 10 MB
        'export_script':   REPO_ROOT / 'scripts' / 'export_demucs_onnx.py',
        'size_limit_label': '90 MB',
    },
    {
        'filename':        'bsrnn_vocals.onnx',
        'min_bytes':       100_000,        # fallback model can be small; real > 1 MB
        'export_script':   REPO_ROOT / 'scripts' / 'export_bsrnn_onnx.py',
        'size_limit_label': '50 MB',
    },
]

# The rewrite source that all model rewrites must appear before.
# This is the raw JSON-string value (not regex) stored in vercel.json.
CATCHALL_SOURCE = '/app/((?!sw\\.js).*)'


# ---------------------------------------------------------------------------
# Environment / pre-flight
# ---------------------------------------------------------------------------

def check_env() -> tuple[str, Optional[str]]:
    """Validate required env vars. Returns (token, team_id). Exits on failure."""
    token = os.environ.get('VERCEL_TOKEN')
    if not token:
        log.error(
            'VERCEL_TOKEN is not set.\n'
            '  Create a token at: https://vercel.com/account/tokens\n'
            '  Then: export VERCEL_TOKEN=vercel_...',
        )
        sys.exit(1)
    team_id = os.environ.get('VERCEL_TEAM_ID') or None
    if team_id:
        log.info('Team ID: %s', team_id)
    return token, team_id


def install_requirements() -> None:
    """pip install -r scripts/requirements_export.txt (quiet, idempotent)."""
    if not REQUIREMENTS_TXT.exists():
        log.warning('requirements_export.txt not found — skipping dep install.')
        return
    log.info('Installing Python deps from %s ...', REQUIREMENTS_TXT.name)
    subprocess.check_call(
        [sys.executable, '-m', 'pip', 'install', '-r', str(REQUIREMENTS_TXT), '--quiet'],
    )
    log.info('Deps ready.')


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

def run_export_script(script: Path) -> None:
    """Run a single export script as a child process from REPO_ROOT."""
    log.info('--- Running: %s ---', script.name)
    t0 = time.time()
    result = subprocess.run(
        [sys.executable, str(script)],
        cwd=str(REPO_ROOT),
    )
    elapsed = time.time() - t0
    if result.returncode != 0:
        log.error('Export script failed: %s (exit %d)', script.name, result.returncode)
        sys.exit(result.returncode)
    log.info('--- Finished %s in %.1fs ---', script.name, elapsed)


# ---------------------------------------------------------------------------
# Copy / verify
# ---------------------------------------------------------------------------

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def copy_model_to_public(filename: str) -> Path:
    """
    Copy models_output/<filename> to public/app/models/<filename>.
    Removes the matching .placeholder file if present.
    """
    src = MODELS_OUTPUT_DIR / filename
    dst = MODELS_PUBLIC_DIR / filename

    if not src.exists():
        log.error(
            'Expected export output not found: %s\n'
            '  Did the export script finish without errors?',
            src,
        )
        sys.exit(1)

    MODELS_PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    log.info('Copied: %s  (%.2f MB)', filename, dst.stat().st_size / 1_048_576)

    placeholder = dst.with_suffix(dst.suffix + '.placeholder')
    if placeholder.exists():
        placeholder.unlink()
        log.info('Removed placeholder: %s', placeholder.name)

    return dst


def verify_model(path: Path, min_bytes: int) -> None:
    """Assert the file exists and is at least min_bytes in size."""
    if not path.exists():
        log.error('Model file missing after copy: %s', path)
        sys.exit(1)
    size = path.stat().st_size
    if size < min_bytes:
        log.error(
            'Model too small: %s — %d bytes (minimum %d).\n'
            '  The export script may have produced a truncated file.',
            path.name, size, min_bytes,
        )
        sys.exit(1)
    log.info('Verified: %s — %.2f MB', path.name, size / 1_048_576)


# ---------------------------------------------------------------------------
# Vercel Blob upload
# ---------------------------------------------------------------------------

def upload_to_vercel_blob(
    file_path: Path,
    blob_name: str,
    token: str,
    team_id: Optional[str],
) -> str:
    """
    Upload file_path to Vercel Blob as blob_name (public access).
    Returns the public HTTPS URL printed by the Blob API.

    Uses a single PUT request — no multipart needed for binary files.
    Docs: https://vercel.com/docs/storage/vercel-blob/using-blob-sdk#upload-a-file
    """
    try:
        import requests as req
    except ImportError:
        log.error("'requests' not installed. Run: pip install requests")
        sys.exit(1)

    url = 'https://blob.vercel-storage.com/' + blob_name
    headers: dict[str, str] = {
        'Authorization': 'Bearer ' + token,
        'Content-Type': 'application/octet-stream',
        'x-vercel-blob-access': 'public',
    }
    if team_id:
        headers['x-vercel-team-id'] = team_id

    size_mb = file_path.stat().st_size / 1_048_576
    log.info('Uploading %s (%.1f MB) ...', blob_name, size_mb)
    t0 = time.time()

    with open(file_path, 'rb') as f:
        resp = req.put(url, headers=headers, data=f, timeout=600)

    if not resp.ok:
        log.error('Blob upload failed — HTTP %d:\n%s', resp.status_code, resp.text[:800])
        sys.exit(1)

    blob_url: str = resp.json().get('url', '')
    if not blob_url:
        log.error('Upload succeeded but response contained no "url" field:\n%s', resp.text)
        sys.exit(1)

    log.info('Uploaded in %.1fs -> %s', time.time() - t0, blob_url)
    return blob_url


# ---------------------------------------------------------------------------
# vercel.json patcher
# ---------------------------------------------------------------------------

def _is_model_rewrite(source: str) -> bool:
    """True for sources of the form /app/models/<name>.onnx."""
    return source.startswith('/app/models/') and source.endswith('.onnx')


def update_vercel_json(new_rewrites: list[dict]) -> None:
    """
    Merge new_rewrites into vercel.json["rewrites"].

    Strategy:
      - Existing model rewrites (/app/models/*.onnx) are kept for models
        not in new_rewrites and replaced/added for those that are.
      - All non-model rewrites are preserved exactly.
      - The merged model rewrites are placed immediately before the
        CATCHALL_SOURCE rule (the /app/((?!sw\\.js).*) catch-all).

    This is idempotent: running twice with the same inputs produces
    the same vercel.json.
    """
    raw = VERCEL_JSON.read_text()
    config: dict = json.loads(raw)
    existing: list[dict] = config.get('rewrites', [])

    # Build a dict of existing model rewrites keyed by source URL
    model_map: dict[str, dict] = {
        r['source']: r
        for r in existing
        if _is_model_rewrite(r['source'])
    }

    # Overwrite / add entries for the models we just processed
    for r in new_rewrites:
        model_map[r['source']] = r

    # Non-model rewrites in original order
    non_model = [r for r in existing if not _is_model_rewrite(r['source'])]

    # Find the catch-all position; insert model rewrites just before it
    insert_idx = next(
        (i for i, r in enumerate(non_model) if r['source'] == CATCHALL_SOURCE),
        len(non_model),    # append at end if catch-all not present (shouldn't happen)
    )

    # Final rewrite list
    merged = (
        non_model[:insert_idx]
        + list(model_map.values())
        + non_model[insert_idx:]
    )
    config['rewrites'] = merged

    VERCEL_JSON.write_text(json.dumps(config, indent=2) + '\n')
    log.info(
        'vercel.json updated: %d model rewrite(s) now present.',
        len(model_map),
    )


# ---------------------------------------------------------------------------
# models-manifest.json sha256 back-fill
# ---------------------------------------------------------------------------

def update_manifest_sha256(sha256_map: dict[str, str]) -> None:
    """Write computed sha256 digests back into models-manifest.json."""
    if not MANIFEST_JSON.exists():
        log.warning('models-manifest.json not found — skipping sha256 update.')
        return

    manifest: dict = json.loads(MANIFEST_JSON.read_text())
    updated = 0
    for model in manifest.get('models', []):
        fn = model.get('filename', '')
        if fn in sha256_map:
            model['sha256'] = sha256_map[fn]
            updated += 1

    if updated:
        MANIFEST_JSON.write_text(json.dumps(manifest, indent=2) + '\n')
        log.info('models-manifest.json: updated sha256 for %d model(s).', updated)


def validate_manifest_consistency(uploaded_filenames: list[str]) -> None:
    """Warn if models-manifest.json references blob-hosted models without rewrites."""
    if not MANIFEST_JSON.exists():
        return

    manifest: dict = json.loads(MANIFEST_JSON.read_text())
    config: dict = json.loads(VERCEL_JSON.read_text())
    rewrite_sources = {r['source'] for r in config.get('rewrites', [])}

    for model in manifest.get('models', []):
        if model.get('delivery') != 'first_run_cache':
            continue
        fn = model.get('filename', '')
        expected_source = f'/app/models/{fn}'
        if expected_source not in rewrite_sources:
            log.warning(
                'MISSING REWRITE: %s is listed in models-manifest.json '
                'with delivery=first_run_cache but has no rewrite in vercel.json.',
                fn,
            )


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description='Export ONNX models locally and upload them to Vercel Blob.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    p.add_argument(
        '--skip-export',
        action='store_true',
        help='Skip model export; use existing files in models_output/.',
    )
    p.add_argument(
        '--skip-upload',
        action='store_true',
        help='Skip Blob upload; only copy to public/ and re-patch vercel.json from existing rewrites.',
    )
    p.add_argument(
        '--only',
        metavar='FILENAME',
        help='Process only one model, e.g. --only rnnoise_suppressor.onnx.',
    )
    return p


def main() -> None:
    args = build_arg_parser().parse_args()

    skip_export = args.skip_export or os.environ.get('SKIP_EXPORT') == '1'
    skip_upload = args.skip_upload or os.environ.get('SKIP_UPLOAD') == '1'

    log.info('=== VoiceIsolate Pro — export_and_upload.py ===')
    log.info('Repo root : %s', REPO_ROOT)
    log.info('skip_export=%s  skip_upload=%s', skip_export, skip_upload)

    # ── Pre-flight ─────────────────────────────────────────────────────────
    token, team_id = check_env()

    models = list(MODELS)
    if args.only:
        models = [m for m in MODELS if m['filename'] == args.only]
        if not models:
            log.error(
                'Unknown model filename: %s\nValid choices: %s',
                args.only,
                ', '.join(m['filename'] for m in MODELS),
            )
            sys.exit(1)

    # ── Step 1: Install deps ────────────────────────────────────────────────
    if not skip_export:
        install_requirements()

    # ── Step 2: Export ─────────────────────────────────────────────────────
    if not skip_export:
        for model in models:
            run_export_script(model['export_script'])

    # ── Step 3: Copy to public/app/models/ and verify ──────────────────────
    sha256_map: dict[str, str] = {}
    for model in models:
        pub_path = copy_model_to_public(model['filename'])
        verify_model(pub_path, model['min_bytes'])
        digest = sha256_file(pub_path)
        sha256_map[model['filename']] = digest
        log.info('SHA-256  %s: %s', model['filename'], digest)

    # ── Step 4: Upload to Vercel Blob ───────────────────────────────────────
    new_rewrites: list[dict] = []

    if not skip_upload:
        for model in models:
            pub_path = MODELS_PUBLIC_DIR / model['filename']
            blob_url = upload_to_vercel_blob(pub_path, model['filename'], token, team_id)
            new_rewrites.append({
                'source':      f"/app/models/{model['filename']}",
                'destination': blob_url,
            })
    else:
        log.info('--skip-upload: reading existing model rewrites from vercel.json.')
        config: dict = json.loads(VERCEL_JSON.read_text())
        new_rewrites = [
            r for r in config.get('rewrites', [])
            if _is_model_rewrite(r['source'])
        ]
        log.info('Found %d existing model rewrite(s).', len(new_rewrites))

    # ── Step 5: Patch vercel.json ───────────────────────────────────────────
    if new_rewrites:
        update_vercel_json(new_rewrites)
    else:
        log.warning(
            'No model rewrites to write — vercel.json unchanged.\n'
            '  If this is unexpected, re-run without --skip-upload.',
        )

    # ── Step 6: Back-fill sha256 in models-manifest.json ───────────────────
    update_manifest_sha256(sha256_map)

    # ── Step 7: Consistency check ───────────────────────────────────────────
    validate_manifest_consistency([m['filename'] for m in models])

    # ── Done ────────────────────────────────────────────────────────────────
    log.info('')
    log.info('=== All done. Next steps: ===')
    log.info('')
    log.info('  git add public/app/models/ vercel.json')
    log.info('  git commit -m "chore(models): refresh ONNX exports and Blob rewrites"')
    log.info('  git push origin main')
    log.info('')
    log.info('  public/app/models/*.onnx are gitignored — only vercel.json and')
    log.info('  the deleted .placeholder stubs will appear in the commit.')


if __name__ == '__main__':
    main()
