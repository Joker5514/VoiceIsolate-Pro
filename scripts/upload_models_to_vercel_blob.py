#!/usr/bin/env python3
"""
upload_models_to_vercel_blob.py — VoiceIsolate Pro

Uploads a local .onnx file to Vercel Blob storage and prints the public URL.
That URL goes into the vercel.json rewrite for /app/models/<filename>.

See MODELS.md for the full workflow.

Usage:
  VERCEL_TOKEN=xxx python scripts/upload_models_to_vercel_blob.py \
      --file ./demucs_v4_quantized.onnx \
      --name demucs_v4_quantized.onnx

Requirements:
  pip install requests
  VERCEL_TOKEN env var must be set (create at https://vercel.com/account/tokens)
  VERCEL_TEAM_ID env var optional (for team projects)
"""

import argparse
import os
import sys

try:
    import requests
except ImportError:
    sys.stderr.write("ERROR: 'requests' not installed. Run: pip install requests\n")
    sys.exit(1)


def upload(filepath, blob_name, token, team_id):
    """
    Upload a file to Vercel Blob and return the public URL.

    Uses the Vercel Blob PUT API (multipart not needed for binary).
    Docs: https://vercel.com/docs/storage/vercel-blob
    """
    url = "https://blob.vercel-storage.com/" + blob_name
    headers = {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/octet-stream",
        "x-vercel-blob-access": "public",
    }
    if team_id:
        headers["x-vercel-team-id"] = team_id

    file_size = os.path.getsize(filepath)
    print("Uploading {} ({:.1f} MB) -> {} ...".format(
        filepath, file_size / 1024 / 1024, blob_name))

    with open(filepath, "rb") as f:
        resp = requests.put(url, headers=headers, data=f, timeout=300)

    if not resp.ok:
        sys.stderr.write("ERROR {}: {}\n".format(resp.status_code, resp.text))
        sys.exit(1)

    data = resp.json()
    public_url = data.get("url")
    print("\n  Uploaded successfully.")
    print("  Public URL : {}".format(public_url))
    print("\nAdd this to vercel.json rewrites (before the /app/(.*) catch-all):")
    print('  {{"source": "/app/models/{}", "destination": "{}"}}'.format(
        blob_name, public_url))
    print("\nDo NOT add this URL anywhere in the browser JS — the rewrite handles it.")
    print("All browser fetches stay on /app/models/<filename> (same-origin).")
    return public_url


def main():
    parser = argparse.ArgumentParser(description="Upload an .onnx model to Vercel Blob")
    parser.add_argument("--file", required=True, help="Local path to the .onnx file")
    parser.add_argument("--name", required=True,
                        help="Blob storage filename (e.g. demucs_v4_quantized.onnx)")
    args = parser.parse_args()

    token = os.environ.get("VERCEL_TOKEN")
    if not token:
        sys.stderr.write("ERROR: VERCEL_TOKEN environment variable not set.\n")
        sys.stderr.write("Create a token at: https://vercel.com/account/tokens\n")
        sys.exit(1)

    if not os.path.isfile(args.file):
        sys.stderr.write("ERROR: file not found: {}\n".format(args.file))
        sys.exit(1)

    team_id = os.environ.get("VERCEL_TEAM_ID")
    upload(args.file, args.name, token, team_id)


if __name__ == "__main__":
    main()
