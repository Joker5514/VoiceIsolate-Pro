#!/usr/bin/env python3
"""
VoiceIsolate Pro — local SAM-Audio worker (Option B).

- Binds 127.0.0.1 only by default.
- Never logs audio, prompts, or credentials.
- Uses Meta sam_audio when installed + HF access; otherwise a deterministic mock
  separator so CI/dev work without gated weights.

Endpoints:
  GET  /health
  GET  /capabilities
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
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlparse

HOST = os.environ.get("SAM_AUDIO_HOST", "127.0.0.1")
PORT = int(os.environ.get("SAM_AUDIO_PORT", "8765"))
MODEL_ID = os.environ.get("SAM_AUDIO_MODEL", "facebook/sam-audio-small")
DEVICE_PREF = os.environ.get("SAM_AUDIO_DEVICE", "auto")
MODE = os.environ.get("SAM_AUDIO_MODE", "local-worker")

_cancelled: set[str] = set()
_lock = threading.Lock()
_sam_bundle: Optional[Tuple[Any, Any, str, bool]] = None


def _log(msg: str) -> None:
    # Never print audio, prompts, or tokens.
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


def _try_load_sam() -> Tuple[Any, Any, str, bool]:
    """Returns (model, processor, device, mock).

    Real Meta SAM-Audio when `sam_audio` + weights are available (Desktop GPU/CPU).
    Set SAM_AUDIO_REQUIRE_REAL=1 to fail instead of mock (production Desktop).
    """
    global _sam_bundle
    if _sam_bundle is not None:
        return _sam_bundle
    device = _resolve_device()
    require_real = os.environ.get("SAM_AUDIO_REQUIRE_REAL", "").lower() in ("1", "true", "yes")
    try:
        from sam_audio import SAMAudio, SAMAudioProcessor  # type: ignore

        # HF token stays in process env only (never sent to clients).
        model = SAMAudio.from_pretrained(MODEL_ID)
        processor = SAMAudioProcessor.from_pretrained(MODEL_ID)
        model = model.eval()
        if device == "cuda":
            model = model.cuda()
        _sam_bundle = (model, processor, device, False)
        _log(f"REAL sam_audio loaded on {device} model={MODEL_ID}")
        return _sam_bundle
    except Exception as exc:
        if require_real:
            _log(f"REAL sam required but load failed: {type(exc).__name__}")
            raise
        _log(f"sam_audio unavailable ({type(exc).__name__}); using mock separator")
        _sam_bundle = (None, None, device, True)
        return _sam_bundle


def _f32_from_b64(b64: str) -> list[float]:
    raw = base64.b64decode(b64)
    n = len(raw) // 4
    return list(struct.unpack("<" + "f" * n, raw[: n * 4]))


def _f32_to_b64(samples: list[float]) -> str:
    raw = struct.pack("<" + "f" * len(samples), *[float(x) for x in samples])
    return base64.b64encode(raw).decode("ascii")


def _mock_separate(pcm: list[float], prompt: str) -> Tuple[list[float], list[float]]:
    """
    Deterministic local mock: soft high-shelf keep for 'speech-like' prompts,
    complementary residual. Not SAM quality — CI/dev only.
    """
    # One-pole high-pass for "speech" energy caricature.
    hp = 0.0
    alpha = 0.995 if "speech" in prompt.lower() or "person" in prompt.lower() or "man" in prompt.lower() or "woman" in prompt.lower() else 0.9
    target: list[float] = []
    residual: list[float] = []
    prev = 0.0
    for x in pcm:
        hp = alpha * (hp + x - prev)
        prev = x
        t = max(-1.0, min(1.0, hp * 1.2))
        r = max(-1.0, min(1.0, x - t))
        # NaN guard
        if math.isnan(t) or math.isinf(t):
            t = 0.0
        if math.isnan(r) or math.isinf(r):
            r = 0.0
        target.append(t)
        residual.append(r)
    return target, residual


def _real_separate(pcm: list[float], sr: int, prompt: str, predict_spans: bool, rerank: int) -> Tuple[list[float], list[float], bool]:
    model, processor, device, mock = _try_load_sam()
    if mock or model is None or processor is None:
        t, r = _mock_separate(pcm, prompt)
        return t, r, True
    # Real path — expects file-like or array API; keep minimal and local.
    import numpy as np  # type: ignore
    import torch  # type: ignore

    audio = np.asarray(pcm, dtype=np.float32)
    batch = processor(audios=[audio], descriptions=[prompt], sampling_rate=sr)
    if device == "cuda":
        batch = batch.to("cuda")
    with torch.inference_mode():
        result = model.separate(
            batch,
            predict_spans=bool(predict_spans),
            reranking_candidates=int(rerank) if rerank else 1,
        )
    target = result.target
    residual = result.residual
    if hasattr(target, "detach"):
        target = target.detach().cpu().numpy().reshape(-1).tolist()
    else:
        target = list(target)
    if hasattr(residual, "detach"):
        residual = residual.detach().cpu().numpy().reshape(-1).tolist()
    else:
        residual = list(residual)
    return target, residual, False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Suppress default access logs (may include long bodies in errors).
        return

    def _send(self, code: int, obj: Dict[str, Any]) -> None:
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path == "/health":
            self._send(200, {"ok": True, "service": "sam-audio-worker", "mode": MODE})
            return
        if path == "/capabilities":
            _, _, device, mock = _try_load_sam()
            self._send(
                200,
                {
                    "available": MODE not in ("disabled", "off", "0", "false"),
                    "backends": ["sam-audio-worker"],
                    "model": MODEL_ID,
                    "device": device,
                    "mock": mock,
                    "live": False,
                    "offline": True,
                    "reasons": [] if MODE not in ("disabled", "off") else ["mode-disabled"],
                },
            )
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
            self._send(500, {"error": "separate-failed", "type": type(exc).__name__})
            return

        with _lock:
            if job and job in _cancelled:
                self._send(499, {"error": "cancelled"})
                return

        resp: Dict[str, Any] = {
            "sampleRate": sr,
            "mock": mock,
            "model": MODEL_ID,
            "device": _resolve_device(),
            "jobId": job,
        }
        if out_mode in ("target", "both"):
            resp["targetBase64"] = _f32_to_b64(target)
        if out_mode in ("residual", "both"):
            resp["residualBase64"] = _f32_to_b64(residual)
        self._send(200, resp)


def main() -> None:
    parser = argparse.ArgumentParser(description="VoiceIsolate Pro local SAM-Audio worker")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()
    host = args.host
    if host not in ("127.0.0.1", "localhost", "::1"):
        _log("refusing non-loopback bind; forcing 127.0.0.1")
        host = "127.0.0.1"
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
