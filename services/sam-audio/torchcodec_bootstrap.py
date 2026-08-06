"""
Make SAM-Audio importable on Windows even when torchcodec/FFmpeg shared libs fail.

Our worker always sends float PCM tensors (never file paths), so AudioDecoder /
VideoDecoder are not required for the production text-prompt path.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from types import ModuleType
from typing import Any


def _prepend_ffmpeg_path() -> str | None:
    """Prefer project-bundled shared FFmpeg DLLs (torchcodec needs shared, not static)."""
    roots = [
        os.environ.get("VIP_FFMPEG_SHARED_BIN"),
        os.environ.get("FFMPEG_BIN"),
    ]
    # Repo-relative defaults
    here = Path(__file__).resolve()
    candidates = [
        here.parents[2] / ".tools" / "ffmpeg-shared",
        here.parents[1] / "ffmpeg-shared",
        Path(os.environ.get("VIP_TOOLS", "")) / "ffmpeg-shared",
    ]
    for c in candidates:
        if not c or not str(c):
            continue
        for bin_dir in c.rglob("bin"):
            if any(bin_dir.glob("avcodec*.dll")) or any(bin_dir.glob("libavcodec*.so*")):
                roots.append(str(bin_dir))
                break

    for r in roots:
        if not r:
            continue
        p = Path(r)
        if p.is_dir():
            os.environ["PATH"] = str(p) + os.pathsep + os.environ.get("PATH", "")
            return str(p)
    return None


def _install_stub() -> None:
    """Minimal torchcodec stub so sam_audio.model can import."""

    class _Decoder:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            raise RuntimeError(
                "torchcodec decoder unavailable; pass float PCM tensors "
                "(VoiceIsolate Pro worker always does)."
            )

    torchcodec = ModuleType("torchcodec")
    decoders = ModuleType("torchcodec.decoders")
    encoders = ModuleType("torchcodec.encoders")
    samplers = ModuleType("torchcodec.samplers")
    transforms = ModuleType("torchcodec.transforms")
    _core = ModuleType("torchcodec._core")

    decoders.AudioDecoder = _Decoder  # type: ignore[attr-defined]
    decoders.VideoDecoder = _Decoder  # type: ignore[attr-defined]

    class AudioStreamMetadata:  # noqa: N801
        pass

    class VideoStreamMetadata:  # noqa: N801
        pass

    _core.AudioStreamMetadata = AudioStreamMetadata  # type: ignore[attr-defined]
    _core.VideoStreamMetadata = VideoStreamMetadata  # type: ignore[attr-defined]

    torchcodec.decoders = decoders  # type: ignore[attr-defined]
    torchcodec.encoders = encoders  # type: ignore[attr-defined]
    torchcodec.samplers = samplers  # type: ignore[attr-defined]
    torchcodec.transforms = transforms  # type: ignore[attr-defined]
    torchcodec._core = _core  # type: ignore[attr-defined]

    sys.modules["torchcodec"] = torchcodec
    sys.modules["torchcodec.decoders"] = decoders
    sys.modules["torchcodec.encoders"] = encoders
    sys.modules["torchcodec.samplers"] = samplers
    sys.modules["torchcodec.transforms"] = transforms
    sys.modules["torchcodec._core"] = _core


def bootstrap_torchcodec() -> dict:
    """
    Returns status dict:
      mode: 'native' | 'stub'
      ffmpeg_bin: path or None
      error: optional message
    """
    ffmpeg_bin = _prepend_ffmpeg_path()
    try:
        import torchcodec  # noqa: F401
        from torchcodec.decoders import AudioDecoder  # noqa: F401

        return {"mode": "native", "ffmpeg_bin": ffmpeg_bin, "error": None}
    except Exception as exc:
        _install_stub()
        return {
            "mode": "stub",
            "ffmpeg_bin": ffmpeg_bin,
            "error": f"{type(exc).__name__}: {exc}"[:300],
        }
