#!/usr/bin/env python3
"""
scripts/upload-to-huggingface.py

Uploads ONNX model files in models/ to a HuggingFace Hub model repo and prints
the resolve URLs. Optionally writes the URLs back into
public/app/models-manifest.json (huggingface source entries).

Required env vars:
    HF_TOKEN    – HuggingFace user access token with write scope on REPO_ID

Usage:
    HF_TOKEN=hf_... python scripts/upload-to-huggingface.py
"""
import glob
import json
import os
import sys
from pathlib import Path

try:
    from huggingface_hub import HfApi
except ImportError:
    sys.stderr.write(
        "ERROR: huggingface_hub is not installed. Run:\n"
        "    pip install huggingface_hub\n"
    )
    sys.exit(1)

REPO_ID = "Joker5514/voice-isolate-models"

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"
MANIFEST_PATH = ROOT / "public" / "app" / "models-manifest.json"


def update_manifest(uploaded):
    """Rewrite huggingface URLs in models-manifest.json for any model whose
    filename matches a manifest entry."""
    if not MANIFEST_PATH.exists():
        print(f"WARN: manifest not found at {MANIFEST_PATH}, skipping rewrite")
        return
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest = json.load(f)
    if "models" not in manifest:
        print("WARN: manifest has no `models` map, skipping rewrite")
        return

    filename_to_key = {entry["filename"]: key for key, entry in manifest["models"].items()}

    changed = False
    for filename, hf_url in uploaded.items():
        key = filename_to_key.get(filename)
        if not key:
            print(f"  (no manifest entry for {filename}, skipping)")
            continue
        sources = manifest["models"][key].setdefault("sources", [])
        hf_source = next((s for s in sources if s.get("provider") == "huggingface"), None)
        if hf_source:
            hf_source["url"] = hf_url
        else:
            sources.append({"provider": "huggingface", "url": hf_url})
        changed = True

    if changed:
        with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
            f.write("\n")
        print(f"\nManifest updated: {MANIFEST_PATH}")


def main():
    token = os.environ.get("HF_TOKEN")
    if not token:
        sys.stderr.write("ERROR: HF_TOKEN env var is required.\n")
        sys.exit(1)

    if not MODELS_DIR.exists():
        sys.stderr.write(f"ERROR: models/ directory not found at {MODELS_DIR}\n")
        sys.exit(1)

    api = HfApi(token=token)

    # Create repo if it doesn't exist
    api.create_repo(repo_id=REPO_ID, repo_type="model", exist_ok=True, private=False)

    onnx_paths = sorted(glob.glob(str(MODELS_DIR / "*.onnx")))
    if not onnx_paths:
        print("WARN: no .onnx files found in models/, nothing to upload")
        return

    uploaded = {}
    for path in onnx_paths:
        filename = os.path.basename(path)
        print(f"Uploading {filename}...")
        api.upload_file(
            path_or_fileobj=path,
            path_in_repo=filename,
            repo_id=REPO_ID,
            repo_type="model",
        )
        hf_url = f"https://huggingface.co/{REPO_ID}/resolve/main/{filename}"
        uploaded[filename] = hf_url
        print(f"  → {hf_url}")

    update_manifest(uploaded)
    print("\nDone. /resolve/main/ URLs written to manifest huggingface sources.")


if __name__ == "__main__":
    main()
