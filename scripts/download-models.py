#!/usr/bin/env python3
"""
VoiceIsolate Pro - ONNX Model Downloader

Automatically downloads all required ONNX models for the ML pipeline:
1. Silero VAD v5 (Voice Activity Detection)
2. ECAPA-TDNN (Speaker Embedding)
3. Demucs v4 (requires manual export - see instructions)

Usage:
    python scripts/download-models.py
"""

import os
import sys
import urllib.request
import hashlib
from pathlib import Path

# Model URLs and metadata
MODELS = {
    'silero-vad.onnx': {
        'url': 'https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx',
        'size_mb': 2.24,
        'sha256': 'a4a068cd6cf1ea8355b84327595838ca748ec29a25bc91fc82e6c299ccdc5808'
    },
    'ecapa-tdnn.onnx': {
        'url': 'https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb/resolve/main/embedding_model.onnx',
        'size_mb': 6.5,
        'sha256': None  # Not available - will skip verification
    }
}

class DownloadProgress:
    """Simple progress bar for downloads"""
    def __init__(self, total_size):
        self.total_size = total_size
        self.downloaded = 0

    def update(self, chunk_size):
        self.downloaded += chunk_size
        percent = (self.downloaded / self.total_size) * 100
        bar_length = 50
        filled = int(bar_length * self.downloaded / self.total_size)
        bar = '█' * filled + '░' * (bar_length - filled)
        mb_downloaded = self.downloaded / (1024 * 1024)
        mb_total = self.total_size / (1024 * 1024)
        print(f'\r{bar} {percent:.1f}% ({mb_downloaded:.1f}/{mb_total:.1f} MB)', end='', flush=True)

def download_file(url, destination, expected_size=None, expected_sha256=None):
    """Download file with progress bar and optional checksum verification"""
    try:
        # Get file size
        with urllib.request.urlopen(url) as response:
            total_size = int(response.headers.get('Content-Length', 0))
            if total_size == 0 and expected_size:
                total_size = int(expected_size * 1024 * 1024)

        print(f'Downloading {destination.name} ({total_size / (1024*1024):.1f} MB)...')
        progress = DownloadProgress(total_size)

        # Download with progress
        def reporthook(chunk_num, chunk_size, total_size):
            if chunk_num > 0:
                progress.update(chunk_size)

        urllib.request.urlretrieve(url, destination, reporthook=reporthook)
        print()  # New line after progress bar

        # Verify checksum if provided
        if expected_sha256:
            print(f'Verifying checksum...')
            sha256 = hashlib.sha256()
            with open(destination, 'rb') as f:
                for chunk in iter(lambda: f.read(4096), b''):
                    sha256.update(chunk)
            actual_sha256 = sha256.hexdigest()
            if actual_sha256 != expected_sha256:
                print(f'❌ Checksum mismatch! Expected {expected_sha256}, got {actual_sha256}')
                return False
            print(f'✅ Checksum verified')

        print(f'✅ Downloaded {destination.name}\n')
        return True

    except Exception as e:
        print(f'\n❌ Error downloading {destination.name}: {e}')
        return False

def main():
    # Determine project root (assume script is in /scripts)
    script_dir = Path(__file__).parent
    project_root = script_dir.parent
    models_dir = project_root / 'public' / 'models'

    # Create models directory
    models_dir.mkdir(parents=True, exist_ok=True)
    print(f'Models directory: {models_dir}\n')

    # Download each model
    success_count = 0
    for filename, metadata in MODELS.items():
        destination = models_dir / filename

        # Skip if already exists
        if destination.exists():
            file_size_mb = destination.stat().st_size / (1024 * 1024)
            print(f'⏭️  {filename} already exists ({file_size_mb:.1f} MB) - skipping\n')
            success_count += 1
            continue

        # Download
        if download_file(
            metadata['url'],
            destination,
            metadata.get('size_mb'),
            metadata.get('sha256')
        ):
            success_count += 1

    # Print Demucs instructions
    print('='*70)
    print('📋 DEMUCS v4 SETUP REQUIRED')
    print('='*70)
    print('''
Demucs v4 requires manual ONNX export due to model size and complexity.

🔧 Export Instructions:

1. Install dependencies:
   pip install demucs torch onnx onnxruntime

2. Export Demucs v4 to ONNX (using community export script):
   git clone https://github.com/GitStroberi/demucs-onnx.git
   cd demucs-onnx
   python export_demucs.py --model htdemucs --output ../public/models/demucs-v4.onnx

3. (Optional) Quantize for faster browser inference:
   pip install onnxruntime-tools
   python -m onnxruntime.quantization.quantize_dynamic \
       public/models/demucs-v4.onnx \
       public/models/demucs-v4-quant.onnx

📖 More info: https://github.com/GitStroberi/demucs-onnx
           or: https://mixxx.org/news/2025-10-27-gsoc2025-demucs-to-onnx-dhunstack/
''')

    # Summary
    print('='*70)
    print(f'✅ Downloaded {success_count}/{len(MODELS)} models successfully')
    print('='*70)
    print(f'\nModels location: {models_dir}')
    print('\nNext steps:')
    print('1. Export Demucs v4 following instructions above')
    print('2. Run: npm run dev')
    print('3. Test the AudioBridge: await bridge.init()')

    # Exit with success if at least Silero + ECAPA downloaded
    sys.exit(0 if success_count >= 2 else 1)

if __name__ == '__main__':
    main()
