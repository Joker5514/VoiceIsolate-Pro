#!/usr/bin/env python3
"""
VoiceIsolate Pro — production SAM-Audio local worker.

- Binds 127.0.0.1 only by default (never public).
- Never logs audio, prompts, or credentials.
- Production: real Meta sam_audio when package + HF weights available.
- Dev/CI: deterministic mock if SAM_AUDIO_ALLOW_MOCK=1 (default in non-production).

Endpoints:
  GET  /health
  GET  /capabilities
  GET  /ready
  POST /separate
  POST /cancel
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import struct
import sys
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

# Bootstrap torchcodec BEFORE any sam_audio import (Windows FFmpeg/torchcodec).
from torchcodec_bootstrap import bootstrap_torchcodec  # noqa: E402

_TORCHCODEC_STATUS = bootstrap_torchcodec()
_HUB_COMPAT_STATUS: Dict[str, Any] = {"ok": False, "patched": False}

HOST = os.environ.get("SAM_AUDIO_HOST", "127.0.0.1")
PORT = int(os.environ.get("SAM_AUDIO_PORT", "8765"))
MODEL_ID = os.environ.get("SAM_AUDIO_MODEL", "facebook/sam-audio-small")
DEVICE_PREF = os.environ.get("SAM_AUDIO_DEVICE", "auto")
MODE = os.environ.get("SAM_AUDIO_MODE", "local-worker")
# Production default: require real model (set SAM_AUDIO_ALLOW_MOCK=1 for CI)
_ALLOW_MOCK = os.environ.get(
    "SAM_AUDIO_ALLOW_MOCK",
    "0" if os.environ.get("SAM_AUDIO_PRODUCTION", "").lower() in ("1", "true", "yes") else "1",
).lower() in ("1", "true", "yes")
_REQUIRE_REAL = os.environ.get("SAM_AUDIO_REQUIRE_REAL", "").lower() in ("1", "true", "yes") or (
    os.environ.get("SAM_AUDIO_PRODUCTION", "").lower() in ("1", "true", "yes")
)


def _apply_hub_compat() -> Dict[str, Any]:
    """Patch sam_audio BaseModel for huggingface_hub 1.x (proxies/resume_download)."""
    global _HUB_COMPAT_STATUS
    try:
        from sam_hub_compat import apply_sam_hub_compat

        _HUB_COMPAT_STATUS = apply_sam_hub_compat()
    except Exception as exc:
        _HUB_COMPAT_STATUS = {
            "ok": False,
            "patched": False,
            "reason": f"{type(exc).__name__}: {exc}",
        }
    return _HUB_COMPAT_STATUS

_cancelled: set[str] = set()
_lock = threading.Lock()
# (model, processor, device, mock, load_error)
_sam_bundle: Optional[Tuple[Any, Any, str, bool, Optional[str]]] = None


def _log(msg: str) -> None:
    sys.stderr.write(f"[sam-audio-worker] {msg}\n")
    sys.stderr.flush()


def _resolve_device() -> str:
    if DEVICE_PREF in ("cuda", "cpu"):
        return DEVICE_PREF
    try:
        import torch  # type: ignore

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _try_load_sam() -> Tuple[Any, Any, str, bool, Optional[str]]:
    """Returns (model, processor, device, mock, error)."""
    global _sam_bundle
    if _sam_bundle is not None:
        return _sam_bundle
    device = _resolve_device()
    try:
        from sam_audio import SAMAudio, SAMAudioProcessor  # type: ignore

        # Must run after sam_audio is importable; before from_pretrained.
        compat = _apply_hub_compat()
        if not compat.get("ok"):
            _log(f"hub compat patch skipped: {compat.get('reason')}")

        token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
        # token=None still uses cached `hf auth login` when present
        fp_kwargs: Dict[str, Any] = {}
        if token:
            fp_kwargs["token"] = token
        model = SAMAudio.from_pretrained(MODEL_ID, **fp_kwargs)
        processor = SAMAudioProcessor.from_pretrained(MODEL_ID)
        model = model.eval()
        if device == "cuda":
            model = model.cuda()
        _sam_bundle = (model, processor, device, False, None)
        _log(f"REAL sam_audio loaded on {device} model={MODEL_ID}")
        return _sam_bundle
    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}"
        # Truncate long HF errors but keep signal
        if len(err) > 400:
            err = err[:400] + "…"
        if _REQUIRE_REAL and not _ALLOW_MOCK:
            _log(f"REAL sam required but load failed: {err}")
            _sam_bundle = (None, None, device, True, err)
            return _sam_bundle
        _log(f"sam_audio load failed ({type(exc).__name__}); mock={'yes' if _ALLOW_MOCK else 'blocked'}")
        _sam_bundle = (None, None, device, True, err)
        return _sam_bundle


def _readiness() -> Dict[str, Any]:
    device = _resolve_device()
    package_ok = False
    try:
        import sam_audio  # noqa: F401

        package_ok = True
    except Exception as exc:
        package_ok = False
        pkg_err = f"{type(exc).__name__}"
    else:
        pkg_err = None

    model, processor, device, mock, load_err = (
        _try_load_sam() if package_ok else (None, None, device, True, pkg_err)
    )
    real = package_ok and not mock and model is not None
    production = os.environ.get("SAM_AUDIO_PRODUCTION", "").lower() in ("1", "true", "yes")
    ready = MODE not in ("disabled", "off", "0", "false") and (
        real or (_ALLOW_MOCK and mock)
    )
    if production and not real:
        ready = False

    return {
        "ready": ready,
        "available": ready,
        "production": production,
        "real": real,
        "mock": mock and not real,
        "packageInstalled": package_ok,
        "modelId": MODEL_ID,
        "device": device,
        "torchcodec": _TORCHCODEC_STATUS,
        "hubCompat": _HUB_COMPAT_STATUS,
        "loadError": load_err,
        "allowMock": _ALLOW_MOCK,
        "mode": MODE,
        "backends": ["sam-audio-worker"],
        "live": False,
        "offline": True,
        "hfAuthHint": (
            "Set HF_TOKEN or run: hf auth login (after Meta gated access)"
            if not real and package_ok
            else None
        ),
        "reasons": []
        if ready
        else (
            ["mode-disabled"]
            if MODE in ("disabled", "off", "0", "false")
            else (
                ["real-sam-required", load_err or "model-not-loaded"]
                if production or _REQUIRE_REAL
                else [load_err or "not-ready"]
            )
        ),
    }


def _f32_from_b64(b64: str) -> list[float]:
    raw = base64.b64decode(b64)
    n = len(raw) // 4
    return list(struct.unpack("<" + "f" * n, raw[: n * 4]))


def _f32_to_b64(samples: list[float]) -> str:
    raw = struct.pack("<" + "f" * len(samples), *[float(x) for x in samples])
    return base64.b64encode(raw).decode("ascii")


def _mock_separate(pcm: list[float], prompt: str) -> Tuple[list[float], list[float]]:
    hp = 0.0
    pl = prompt.lower()
    alpha = (
        0.995
        if any(k in pl for k in ("speech", "person", "man", "woman", "voice", "talk"))
        else 0.9
    )
    target: list[float] = []
    residual: list[float] = []
    prev = 0.0
    for x in pcm:
        hp = alpha * (hp + x - prev)
        prev = x
        t = max(-1.0, min(1.0, hp * 1.2))
        r = max(-1.0, min(1.0, x - t))
        if math.isnan(t) or math.isinf(t):
            t = 0.0
        if math.isnan(r) or math.isinf(r):
            r = 0.0
        target.append(t)
        residual.append(r)
    return target, residual


def _to_list(x: Any) -> list[float]:
    if hasattr(x, "detach"):
        import numpy as np  # type: ignore

        arr = x.detach().float().cpu().numpy().reshape(-1)
        return arr.astype(float).tolist()
    if hasattr(x, "reshape"):
        return list(x.reshape(-1))
    return list(x)


def _real_separate(
    pcm: list[float], sr: int, prompt: str, predict_spans: bool, rerank: int
) -> Tuple[list[float], list[float], bool]:
    model, processor, device, mock, load_err = _try_load_sam()
    if mock or model is None or processor is None:
        if _REQUIRE_REAL and not _ALLOW_MOCK:
            raise RuntimeError(load_err or "real-sam-unavailable")
        t, r = _mock_separate(pcm, prompt)
        return t, r, True

    import numpy as np  # type: ignore
    import torch  # type: ignore

    audio = np.asarray(pcm, dtype=np.float32)
    # Prefer tensor path (avoids file decoders / torchcodec)
    try:
        batch = processor(
            audios=[audio],
            descriptions=[prompt],
            sampling_rate=sr,
        )
    except TypeError:
        batch = processor(audios=[audio], descriptions=[prompt])

    if device == "cuda":
        batch = batch.to("cuda")
    with torch.inference_mode():
        result = model.separate(
            batch,
            predict_spans=bool(predict_spans),
            reranking_candidates=int(rerank) if rerank else 1,
        )
    target = _to_list(result.target)
    residual = _to_list(result.residual)
    # Match length
    n = len(pcm)
    if len(target) != n:
        if len(target) > n:
            target = target[:n]
        else:
            target = target + [0.0] * (n - len(target))
    if len(residual) != n:
        if len(residual) > n:
            residual = residual[:n]
        else:
            residual = residual + [0.0] * (n - len(residual))
    return target, residual, False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        return

    def _send(self, code: int, obj: Dict[str, Any]) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-VIP-SAM-Worker", "1")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            self._send(
                200,
                {
                    "ok": True,
                    "service": "sam-audio-worker",
                    "mode": MODE,
                    "version": "25.0.1",
                    "torchcodec": _TORCHCODEC_STATUS.get("mode"),
                    "hubCompat": bool(_HUB_COMPAT_STATUS.get("patched")),
                },
            )
            return
        if path in ("/capabilities", "/ready"):
            ready = _readiness()
            code = 200 if ready.get("ready") or path == "/capabilities" else 503
            if path == "/ready" and not ready.get("ready"):
                code = 503
            self._send(code, ready)
            return
        self._send(404, {"error": "not-found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        if length > 64 * 1024 * 1024:
            self._send(413, {"error": "payload-too-large"})
            return
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            self._send(400, {"error": "invalid-json"})
            return

        if path == "/cancel":
            job = str(body.get("jobId") or "")
            with _lock:
                _cancelled.add(job)
            self._send(200, {"ok": True})
            return

        if path != "/separate":
            self._send(404, {"error": "not-found"})
            return

        if MODE in ("disabled", "off", "0", "false"):
            self._send(503, {"error": "sam-disabled"})
            return

        job = str(body.get("jobId") or "")
        b64 = body.get("audioBase64")
        if not b64 or not isinstance(b64, str):
            self._send(400, {"error": "audioBase64-required"})
            return
        try:
            pcm = _f32_from_b64(b64)
        except Exception:
            self._send(400, {"error": "audio-decode-failed"})
            return
        if len(pcm) < 16:
            self._send(400, {"error": "audio-too-short"})
            return
        if len(pcm) > 48_000 * 60 * 30:
            self._send(413, {"error": "audio-too-long"})
            return

        sr = int(body.get("sampleRate") or 48000)
        prompt = str(body.get("prompt") or "person speaking")
        predict_spans = bool(body.get("predictSpans"))
        rerank = int(body.get("rerankingCandidates") or 1)
        out_mode = str(body.get("output") or "both")

        with _lock:
            if job and job in _cancelled:
                self._send(499, {"error": "cancelled"})
                return

        try:
            target, residual, mock = _real_separate(pcm, sr, prompt, predict_spans, rerank)
        except Exception as exc:
            _log(f"separate error: {type(exc).__name__}")
            self._send(
                500,
                {
                    "error": "separate-failed",
                    "type": type(exc).__name__,
                    "detail": str(exc)[:200],
                },
            )
            return

        with _lock:
            if job and job in _cancelled:
                self._send(499, {"error": "cancelled"})
                return

        if mock and _REQUIRE_REAL and not _ALLOW_MOCK:
            self._send(503, {"error": "real-sam-required", "mock": True})
            return

        resp: Dict[str, Any] = {
            "sampleRate": sr,
            "mock": mock,
            "real": not mock,
            "model": MODEL_ID,
            "device": _resolve_device(),
            "jobId": job,
            "torchcodec": _TORCHCODEC_STATUS.get("mode"),
        }
        if out_mode in ("target", "both"):
            resp["targetBase64"] = _f32_to_b64(target)
        if out_mode in ("residual", "both"):
            resp["residualBase64"] = _f32_to_b64(residual)
        self._send(200, resp)


def main() -> None:
    parser = argparse.ArgumentParser(description="VoiceIsolate Pro production SAM-Audio worker")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument(
        "--preload",
        action="store_true",
        help="Load SAM model at startup (production warm-start)",
    )
    args = parser.parse_args()
    host = args.host
    if host not in ("127.0.0.1", "localhost", "::1"):
        _log("refusing non-loopback bind; forcing 127.0.0.1")
        host = "127.0.0.1"

    _log(
        f"torchcodec={_TORCHCODEC_STATUS.get('mode')} "
        f"ffmpeg={_TORCHCODEC_STATUS.get('ffmpeg_bin')} "
        f"production={os.environ.get('SAM_AUDIO_PRODUCTION')} "
        f"allow_mock={_ALLOW_MOCK}"
    )
    if args.preload or os.environ.get("SAM_AUDIO_PRELOAD", "").lower() in ("1", "true", "yes"):
        try:
            _try_load_sam()
        except Exception:
            _log("preload failed:\n" + traceback.format_exc(limit=2))

    httpd = ThreadingHTTPServer((host, args.port), Handler)
    _log(f"listening on http://{host}:{args.port} mode={MODE}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
