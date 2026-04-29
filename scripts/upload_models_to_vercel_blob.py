#!/usr/bin/env python3
"""
upload_models_to_vercel_blob.py – VoiceIsolate Pro

Uploads a local .onnx file to Vercel Blob storage and prints the public URL.
That URL goes into the vercel.json rewrite for /app/models/<filename>.

See MODELS.md for the full workflow.

Usage:
  python scripts/upload_models_to_vercel_blob.py \\
      --file ./demucs_v4_quantized.onnx \\
      --name demucs_v4_quantized.onnx

Requirements:
  pip install requests
  VERCEL_TOKEN env var must be set (create at vercel.com/account/tokens)
  VERCEL_TEAM_ID env var optional (for team projects)
"""

import argparse
import os
import sys
import requests


def upload(filepath: str, blob_name: str, token: str, team_id: str | None) -> str:
    """
    Upload a file to Vercel Blob and return the public URL.
    Uses the Vercel Blob PUT API (multipart not needed for binary).
    Docs: https://vercel.com/docs/storage/vercel-blob/using-blob-sdk#put
    """
    url = f"https://blob.vercel-storage.com/{blob_name}"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/octet-stream",
        "x-vercel-blob-access": "public",
    }
    if team_id:
        headers["x-vercel-team-id"] = team_id

    file_size = os.path.getsize(filepath)
    print(f"Uploading {filepath} ({file_size / 1024 / 1024:.1f} MB) → {blob_name} ...")

    with open(filepath, "rb") as f:
        resp = requests.put(url, headers=headers, data=f, timeout=300)

    if not resp.ok:
        print(f"ERROR {resp.status_code}: {resp.text}", file=sys.stderr)
        sys.exit(1)

    data = resp.json()
    public_url = data.get("url")
    print(f"\n✓ Uploaded successfully.")
    print(f"  Public URL : {public_url}")
    print(f"\nAdd this to vercel.json rewrites (before the /app/(.*) catch-all):")
    print(f'  {{"source": "/app/models/{blob_name}", "destination": "{public_url}"}}')
    print(f"\nDo NOT add this URL anywhere in the browser JS – the rewrite handles it.")
    return public_url


def main():
    parser = argparse.ArgumentParser(description="Upload an .onnx model to Vercel Blob")
    parser.add_argument("--file",  required=True, help="Local path to the .onnx file")
    parser.add_argument("--name",  required=True, help="Blob storage filename (e.g. demucs_v4_quantized.onnx)")
    args = parser.parse_args()

    token = os.environ.get("VERCEL_TOKEN")
    if not token:
        print("ERROR: VERCEL_TOKEN environment variable not set.", file=sys.stderr)
        print("Create a token at: https://vercel.com/account/tokens", file=sys.stderr)
        sys.exit(1)

    if not os.path.isfile(args.file):
        print(f"ERROR: file not found: {args.file}", file=sys.stderr)
        sys.exit(1)

    team_id = os.environ.get("VERCEL_TEAM_ID")
    upload(args.file, args.name, token, team_id)


if __name__ == "__main__":
    main()
