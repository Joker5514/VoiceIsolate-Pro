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

Only loopback clients without a browser Origin are served: the Electron main
process (electron/sam-proxy.cjs) and local tools. There is deliberately no
CORS: any web page could otherwise drive this worker. A browser cross-origin
request either carries an Origin header (refused) or, for a non-simple POST,
needs a preflight this server never answers; a rebinding hostname fails the
Host check.

Prompting is text only. Span and visual targeting are refused with 400
`unsupported-targeting` rather than silently running the text prompt.
"""
from __future__ import annotations

import argparse
import base64
import json
import math
import os
import struct
import sys
import re
import threading
import time
import traceback
import uuid
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

# Cancellation bookkeeping: job id -> monotonic time of the cancel. A cancel may
# arrive before its /separate (client aborted early), so entries for unknown
# jobs are kept, but only for CANCEL_TTL_S and at most MAX_CANCELLED entries.
# A job's entry is dropped when that job finishes, so ids never poison later jobs.
CANCEL_TTL_S = 600.0
MAX_CANCELLED = 1024
_JOB_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
SUPPORTED_PROMPT_MODES = ("text",)
_cancelled: Dict[str, float] = {}
_lock = threading.Lock()
_model_load_lock = threading.Lock()
# (model, processor, device, mock, load_error)
_sam_bundle: Optional[Tuple[Any, Any, str, bool, Optional[str]]] = None


def _mark_cancelled(job: str) -> None:
    now = time.monotonic()
    with _lock:
        for k in [k for k, t in _cancelled.items() if now - t > CANCEL_TTL_S]:
            del _cancelled[k]
        _cancelled[job] = now
        while len(_cancelled) > MAX_CANCELLED:
            del _cancelled[next(iter(_cancelled))]


def _is_cancelled(job: str) -> bool:
    with _lock:
        t = _cancelled.get(job)
        return t is not None and time.monotonic() - t <= CANCEL_TTL_S


def _finish_job(job: str) -> None:
    with _lock:
        _cancelled.pop(job, None)


def _log(msg: str) -> None:
    sys.stderr.write(f"[sam-audio-worker] {msg}\n")
    sys.stderr.flush()


def _mock_allowed() -> bool:
    """Mock is blocked whenever real is required (production or REQUIRE_REAL)."""
    return _ALLOW_MOCK and not _REQUIRE_REAL


def _resolve_device() -> str:
    if DEVICE_PREF in ("cuda", "cpu"):
        return DEVICE_PREF
    try:
        import torch  # type: ignore

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _try_load_sam() -> Tuple[Any, Any, str, bool, Optional[str]]:
    """Returns (model, processor, device, mock, error). Thread-safe lazy load."""
    global _sam_bundle
    if _sam_bundle is not None:
        return _sam_bundle
    with _model_load_lock:
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
            if _REQUIRE_REAL:
                _log(f"REAL sam required but load failed: {err}")
            else:
                _log(
                    f"sam_audio load failed ({type(exc).__name__}); "
                    f"mock={'yes' if _mock_allowed() else 'blocked'}"
                )
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
    # REQUIRE_REAL / production: never report ready on mock
    ready = MODE not in ("disabled", "off", "0", "false") and (
        real or (_mock_allowed() and mock)
    )
    if _REQUIRE_REAL and not real:
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
        "allowMock": _mock_allowed(),
        "requireReal": _REQUIRE_REAL,
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
                if _REQUIRE_REAL
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
    """Flatten model outputs (tensor, nested list of tensors, or numeric seq)."""
    # SAM separate() returns lists of batch tensors for target/residual
    if isinstance(x, (list, tuple)):
        if not x:
            return []
        first = x[0]
        # Unwrap batch-of-tensors / nested batch once
        if hasattr(first, "detach"):
            return _to_list(first)
        if isinstance(first, (list, tuple)) and first and hasattr(first[0], "detach"):
            return _to_list(first)
        # Already sample floats (or nested numeric seq)
        try:
            return [float(v) for v in x]
        except (TypeError, ValueError):
            return _to_list(first)
    if hasattr(x, "detach"):
        arr = x.detach().float().cpu().reshape(-1)
        return [float(v) for v in arr.tolist()]
    if hasattr(x, "reshape") and hasattr(x, "__len__"):
        try:
            return [float(v) for v in list(x.reshape(-1))]
        except Exception:
            pass
    try:
        return [float(v) for v in x]
    except TypeError:
        return [float(x)]


def _real_separate(
    pcm: list[float], sr: int, prompt: str, predict_spans: bool, rerank: int
) -> Tuple[list[float], list[float], bool]:
    model, processor, device, mock, load_err = _try_load_sam()
    if mock or model is None or processor is None:
        if _REQUIRE_REAL or not _mock_allowed():
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
        if code >= 400:
            # An early refusal may leave an unread body on the socket; closing
            # stops it from being parsed as the next keep-alive request.
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(data)

    def _allowed(self, post: bool) -> bool:
        """Loopback Host, no browser Origin, JSON bodies only (see module doc)."""
        port = self.server.server_address[1]
        host = (self.headers.get("Host") or "").lower()
        if host not in (f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"):
            self._send(403, {"error": "forbidden-host"})
            return False
        if self.headers.get("Origin") is not None:
            self._send(403, {"error": "forbidden-origin"})
            return False
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if post and ctype != "application/json":
            self._send(415, {"error": "json-required"})
            return False
        return True

    def do_GET(self) -> None:  # noqa: N802
        if not self._allowed(post=False):
            return
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
        if not self._allowed(post=True):
            return
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

        if not isinstance(body, dict):
            self._send(400, {"error": "invalid-json"})
            return

        if path == "/cancel":
            job = body.get("jobId")
            if not isinstance(job, str) or not _JOB_ID_RE.match(job):
                self._send(400, {"error": "invalid-jobId"})
                return
            _mark_cancelled(job)
            self._send(200, {"ok": True})
            return

        if path != "/separate":
            self._send(404, {"error": "not-found"})
            return

        if MODE in ("disabled", "off", "0", "false"):
            self._send(503, {"error": "sam-disabled"})
            return

        job = body.get("jobId")
        if job is None:
            job = f"srv-{uuid.uuid4()}"
        if not isinstance(job, str) or not _JOB_ID_RE.match(job):
            self._send(400, {"error": "invalid-jobId"})
            return
        try:
            self._separate(job, body)
        finally:
            _finish_job(job)

    def _separate(self, job: str, body: Dict[str, Any]) -> None:
        mode = body.get("mode", "text")
        anchors = body.get("anchors") or []
        if mode not in SUPPORTED_PROMPT_MODES or anchors:
            self._send(
                400,
                {"error": "unsupported-targeting", "supported": list(SUPPORTED_PROMPT_MODES)},
            )
            return
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

        if _is_cancelled(job):
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

        if _is_cancelled(job):
            self._send(499, {"error": "cancelled"})
            return

        if mock and (_REQUIRE_REAL or not _mock_allowed()):
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
