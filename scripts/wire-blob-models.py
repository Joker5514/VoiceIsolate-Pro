#!/usr/bin/env python3
"""
wire-blob-models.py — VoiceIsolate Pro

One-command setup: lists Vercel Blob storage, matches model files,
patches vercel.json rewrites with real URLs, and pushes the commit.

Usage:
  VERCEL_TOKEN=xxx python3 scripts/wire-blob-models.py [--upload-dir ./models]

Required env:
  VERCEL_TOKEN     — Create at https://vercel.com/account/tokens

Optional env:
  VERCEL_TEAM_ID   — For team projects (e.g. team_xxx)
  GITHUB_TOKEN     — If set, auto-commits vercel.json via GitHub API
  GITHUB_REPO      — e.g. Joker5514/VoiceIsolate-Pro (required for auto-commit)

Optional args:
  --upload-dir <path>   Local directory containing .onnx files to upload
                        if they aren't already in Blob storage.
                        Files must be named exactly as in MODEL_NAMES below.
"""

import argparse
import json
import os
import sys
import subprocess
import base64

try:
    import requests
except ImportError:
    sys.exit("ERROR: 'requests' not installed. Run: pip install requests")

# ─── Model registry ───────────────────────────────────────────────────────────
# Maps blob filename → vercel.json placeholder string
MODEL_NAMES = {
    "rnnoise_suppressor.onnx":     "<BLOB_RNNOISE_URL>",
    "demucs_v4_quantized.onnx":    "<BLOB_DEMUCS_URL>",
    "bsrnn_vocals.onnx":           "<BLOB_BSRNN_URL>",
}

VERCEL_BLOB_API = "https://blob.vercel-storage.com"
GH_API          = "https://api.github.com"

# ─── Helpers ──────────────────────────────────────────────────────────────────

def blob_headers(token, team_id=None):
    h = {
        "Authorization": f"Bearer {token}",
        "Content-Type":  "application/json",
    }
    if team_id:
        h["x-vercel-team-id"] = team_id
    return h


def list_blobs(token, team_id=None):
    """Return a dict of {pathname: url} for all blobs in storage."""
    url     = VERCEL_BLOB_API
    headers = blob_headers(token, team_id)
    params  = {"limit": 1000}
    blobs   = {}

    while True:
        resp = requests.get(url, headers=headers, params=params, timeout=30)
        if not resp.ok:
            sys.exit(f"ERROR listing blobs ({resp.status_code}): {resp.text}")
        data = resp.json()
        for b in data.get("blobs", []):
            blobs[b["pathname"]] = b["url"]
        cursor = data.get("cursor")
        if not cursor or not data.get("hasMore"):
            break
        params["cursor"] = cursor

    return blobs


def upload_blob(filepath, blob_name, token, team_id=None):
    """Upload a local file to Vercel Blob. Returns the public URL."""
    url     = f"{VERCEL_BLOB_API}/{blob_name}"
    headers = {
        "Authorization":        f"Bearer {token}",
        "Content-Type":         "application/octet-stream",
        "x-vercel-blob-access": "public",
    }
    if team_id:
        headers["x-vercel-team-id"] = team_id

    size_mb = os.path.getsize(filepath) / 1024 / 1024
    print(f"  Uploading {blob_name} ({size_mb:.1f} MB) ...")

    with open(filepath, "rb") as f:
        resp = requests.put(url, headers=headers, data=f, timeout=600)

    if not resp.ok:
        sys.exit(f"ERROR uploading {blob_name} ({resp.status_code}): {resp.text}")

    public_url = resp.json().get("url")
    print(f"  ✅ Uploaded → {public_url}")
    return public_url


def patch_vercel_json(vercel_json_path, url_map):
    """Replace placeholder strings in vercel.json with real Blob URLs."""
    with open(vercel_json_path) as f:
        content = f.read()

    changed = []
    for filename, placeholder in MODEL_NAMES.items():
        if filename in url_map and placeholder in content:
            content = content.replace(placeholder, url_map[filename])
            changed.append(filename)

    if changed:
        with open(vercel_json_path, "w") as f:
            f.write(content)
        print(f"\n✅ Patched vercel.json with URLs for: {', '.join(changed)}")
    else:
        print("\n⚠️  No placeholders found in vercel.json to patch.")
        print("   Either already patched or placeholder strings were manually changed.")

    return changed


def git_commit_and_push(vercel_json_path, changed_models):
    """Commit and push the patched vercel.json via git."""
    msg = f"fix: wire Vercel Blob URLs for {', '.join(changed_models)}"
    try:
        subprocess.run(["git", "add", vercel_json_path], check=True)
        subprocess.run(["git", "commit", "-m", msg], check=True)
        subprocess.run(["git", "push"], check=True)
        print(f"\n🚀 Committed and pushed: {msg}")
        return True
    except subprocess.CalledProcessError as e:
        print(f"\n⚠️  Git push failed: {e}")
        print("   Manually commit vercel.json with your changes and push to trigger a Vercel redeploy.")
        return False


def github_api_commit(repo, token, vercel_json_path, changed_models):
    """Commit vercel.json via GitHub API (works in CI / no local git)."""
    ref_url   = f"{GH_API}/repos/{repo}/git/ref/heads/main"
    ref_resp  = requests.get(ref_url, headers={"Authorization": f"Bearer {token}"})
    if not ref_resp.ok:
        print(f"⚠️  GitHub API: could not get main ref ({ref_resp.status_code})")
        return False

    # Get current file SHA (required for updates)
    file_url  = f"{GH_API}/repos/{repo}/contents/vercel.json"
    file_resp = requests.get(file_url, headers={"Authorization": f"Bearer {token}"})
    if not file_resp.ok:
        print(f"⚠️  GitHub API: could not get vercel.json metadata ({file_resp.status_code})")
        return False

    file_sha = file_resp.json()["sha"]

    with open(vercel_json_path) as f:
        content = f.read()
    content_b64 = base64.b64encode(content.encode()).decode()

    msg  = f"fix: wire Vercel Blob URLs for {', '.join(changed_models)}"
    body = {
        "message": msg,
        "content": content_b64,
        "sha":     file_sha,
        "branch":  "main",
    }
    put_resp = requests.put(
        file_url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
    )
    if put_resp.ok:
        print(f"\n🚀 Pushed to GitHub via API: {msg}")
        return True
    else:
        print(f"⚠️  GitHub API commit failed ({put_resp.status_code}): {put_resp.text}")
        return False


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Wire Vercel Blob URLs into vercel.json")
    parser.add_argument("--upload-dir", default=None,
                        help="Directory with local .onnx files to upload if not in Blob")
    parser.add_argument("--vercel-json", default="vercel.json",
                        help="Path to vercel.json (default: vercel.json)")
    args = parser.parse_args()

    token    = os.environ.get("VERCEL_TOKEN")
    team_id  = os.environ.get("VERCEL_TEAM_ID")
    gh_token = os.environ.get("GITHUB_TOKEN")
    gh_repo  = os.environ.get("GITHUB_REPO")  # e.g. Joker5514/VoiceIsolate-Pro

    if not token:
        sys.exit(
            "ERROR: VERCEL_TOKEN not set.\n"
            "  Create a token at: https://vercel.com/account/tokens\n"
            "  Then run: VERCEL_TOKEN=xxx python3 scripts/wire-blob-models.py"
        )

    if not os.path.isfile(args.vercel_json):
        sys.exit(f"ERROR: vercel.json not found at '{args.vercel_json}'")

    print("━" * 50)
    print("  VoiceIsolate Pro — Blob Model Setup")
    print("━" * 50)

    # ── Step 1: List existing blobs ──────────────────────────────────────────
    print("\n[1/3] Listing Vercel Blob storage...")
    existing_blobs = list_blobs(token, team_id)
    print(f"      Found {len(existing_blobs)} blob(s) in storage")

    found_urls    = {}
    missing_names = []

    for filename in MODEL_NAMES:
        if filename in existing_blobs:
            url = existing_blobs[filename]
            found_urls[filename] = url
            print(f"  ✅  {filename}")
            print(f"       → {url}")
        else:
            missing_names.append(filename)
            print(f"  ❌  {filename}  (not in Blob storage)")

    # ── Step 2: Upload missing models if upload-dir provided ─────────────────
    if missing_names and args.upload_dir:
        print(f"\n[2/3] Uploading missing models from {args.upload_dir} ...")
        for filename in list(missing_names):
            local_path = os.path.join(args.upload_dir, filename)
            if os.path.isfile(local_path):
                url = upload_blob(local_path, filename, token, team_id)
                found_urls[filename] = url
                missing_names.remove(filename)
            else:
                print(f"  ⚠️   {filename} not found at {local_path} — skipping upload")
    elif missing_names:
        print("\n[2/3] No --upload-dir provided. Skipping upload for missing models.")
        print("      To upload missing models, re-run with:")
        print("        --upload-dir <path-to-directory-with-onnx-files>")
        print("\n      Model files needed:")
        for f in missing_names:
            print(f"        • {f}")
        print("\n      To export models locally, run:")
        print("        bash scripts/setup-models.sh")
        print("      Then re-run this script with --upload-dir public/app/models")
    else:
        print("\n[2/3] All models already in Blob storage — no uploads needed.")

    # ── Step 3: Patch vercel.json ─────────────────────────────────────────────
    print(f"\n[3/3] Patching {args.vercel_json} ...")
    if not found_urls:
        print("  ⚠️  No URLs to patch — run again after uploading models.")
        sys.exit(0)

    changed = patch_vercel_json(args.vercel_json, found_urls)

    if not changed:
        print("  Nothing to commit.")
        sys.exit(0)

    # ── Commit & push ─────────────────────────────────────────────────────────
    committed = False
    if gh_token and gh_repo:
        print(f"\nCommitting via GitHub API to {gh_repo} ...")
        committed = github_api_commit(gh_repo, gh_token, args.vercel_json, changed)

    if not committed:
        print("\nCommitting via local git ...")
        committed = git_commit_and_push(args.vercel_json, changed)

    if not committed:
        print("\nManual step: commit and push vercel.json to trigger Vercel redeploy.")

    # ── Summary ────────────────────────────────────────────────────────────────
    print("\n" + "━" * 50)
    if missing_names:
        print(f"⚠️  Still missing {len(missing_names)} model(s): {', '.join(missing_names)}")
        print("   Upload them and re-run this script to complete the setup.")
    else:
        print("✅ All models wired. Vercel will redeploy automatically on push.")
        print("   On first browser visit, eager models (rnnoise, ~180KB) download")
        print("   immediately. Demucs/BSRNN (lazy, 83+45 MB) download when the")
        print("   user first processes a file. All are cached after first run.")
    print("━" * 50)


if __name__ == "__main__":
    main()
