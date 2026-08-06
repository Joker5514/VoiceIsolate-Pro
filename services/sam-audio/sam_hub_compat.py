"""
Compatibility for Meta sam_audio + modern huggingface_hub.

sam_audio.model.base.BaseModel._from_pretrained requires keyword-only
`proxies` and `resume_download`, but huggingface_hub >=1.x no longer
passes them from ModelHubMixin.from_pretrained. snapshot_download also
dropped those kwargs.

Apply this patch after importing sam_audio and before from_pretrained().
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict, Optional, Union


def apply_sam_hub_compat() -> Dict[str, Any]:
    """
    Monkey-patch BaseModel._from_pretrained for hub 1.x.

    Returns status dict {ok, patched, reason?}.
    """
    try:
        import torch
        from huggingface_hub import snapshot_download
        from sam_audio.model.base import BaseModel
    except Exception as exc:
        return {"ok": False, "patched": False, "reason": f"{type(exc).__name__}: {exc}"}

    @classmethod  # type: ignore[misc]
    def _from_pretrained_compat(
        cls,
        *,
        model_id: str,
        cache_dir: Optional[str] = None,
        force_download: bool = False,
        proxies: Optional[Dict] = None,  # accepted, ignored on hub 1.x
        resume_download: bool = False,  # accepted, ignored on hub 1.x
        local_files_only: bool = False,
        token: Union[str, bool, None] = None,
        map_location: str = "cpu",
        strict: bool = True,
        revision: Optional[str] = None,
        **model_kwargs: Any,
    ):
        del proxies, resume_download  # hub 1.x snapshot_download dropped these
        if os.path.isdir(model_id):
            cached_model_dir = model_id
        else:
            rev = getattr(cls, "revision", None) or revision
            dl_kwargs: Dict[str, Any] = {
                "repo_id": model_id,
                "revision": rev,
                "cache_dir": cache_dir,
                "force_download": force_download,
                "token": token,
                "local_files_only": local_files_only,
            }
            # Drop None values some hub versions reject
            dl_kwargs = {k: v for k, v in dl_kwargs.items() if v is not None or k == "local_files_only"}
            cached_model_dir = snapshot_download(**dl_kwargs)

        config_path = os.path.join(cached_model_dir, "config.json")
        with open(config_path, encoding="utf-8") as fin:
            config = json.load(fin)

        for key, value in model_kwargs.items():
            if key in config:
                config[key] = value

        config_cls: Callable = cls.config_cls
        config_obj = config_cls(**config)
        model = cls(config_obj)
        state_dict = torch.load(
            os.path.join(cached_model_dir, "checkpoint.pt"),
            weights_only=True,
            map_location=map_location,
        )
        model.load_state_dict(state_dict, strict=strict)
        return model

    BaseModel._from_pretrained = _from_pretrained_compat  # type: ignore[method-assign,assignment]
    return {"ok": True, "patched": True, "reason": None}
