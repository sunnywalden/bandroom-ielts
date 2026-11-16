"""Optional canonical-pronunciation (TTS) contrast audio for T2/T3 items.

Design rev2 §0.2 / FIX-18: the production grounded path shipped with
``self_listen_enabled = false`` and therefore never delivered T3 at all.  This
module wires the *option* for canonical contrast audio without changing the
default: everything is **off by default and fail-closed**, and tests never touch
the network.

The E3 probe established that ``qwen3-tts-flash`` only works through the native
DashScope multimodal endpoint::

    POST https://dashscope.aliyuncs.com/api/v1/services/aigc/
         multimodal-generation/generation
    {"model": "qwen3-tts-flash",
     "input": {"text": "...", "voice": "Cherry"}}
    -> output.audio.url

The OpenAI-compatible ``/audio/speech`` endpoint returns 404 for this model.

Any error, missing key, timeout, non-200 response or missing URL yields
``status="unavailable"``.  The caller keeps the timestamp-only wording; no
phoneme claim is ever derived from a TTS call.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Callable, Mapping, Sequence

CONTRAST_TTS_MODEL = "qwen3-tts-flash"
CONTRAST_TTS_VOICE = "Cherry"
CONTRAST_TTS_URL = (
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/"
    "multimodal-generation/generation"
)
DEFAULT_TIMEOUT_SECONDS = 60.0

# The transport is injected in tests.  It returns the decoded JSON payload.
ContrastTransport = Callable[[Mapping[str, Any], Mapping[str, str], float], Mapping[str, Any]]


def urllib_transport(
    body: Mapping[str, Any], headers: Mapping[str, str], timeout: float
) -> Mapping[str, Any]:
    request = urllib.request.Request(
        CONTRAST_TTS_URL,
        data=json.dumps(dict(body), ensure_ascii=False).encode("utf-8"),
        headers=dict(headers),
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
        raise RuntimeError(f"tts transport failed: {exc}") from exc
    if not isinstance(payload, Mapping):
        raise RuntimeError("tts response is not a JSON object")
    return payload


def build_request(word: str) -> dict[str, Any]:
    return {
        "model": CONTRAST_TTS_MODEL,
        "input": {"text": str(word), "voice": CONTRAST_TTS_VOICE},
    }


def synthesize_word(
    word: str,
    *,
    enabled: bool = False,
    transport: ContrastTransport | None = None,
    api_key: str = "",
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any]:
    """Return a canonical-audio reference or a fail-closed status document."""
    result: dict[str, Any] = {
        "enabled": bool(enabled),
        "model": CONTRAST_TTS_MODEL,
        "voice": CONTRAST_TTS_VOICE,
    }
    if not enabled:
        result.update(status="disabled", reason="contrast audio disabled by default")
        return result
    text = str(word or "").strip()
    if not text:
        result.update(status="unavailable", reason="empty_word")
        return result
    if transport is None and not api_key:
        # Fail closed before any network call when the credential is absent.
        result.update(status="unavailable", reason="missing_api_key")
        return result
    body = build_request(text)
    headers = {
        "content-type": "application/json",
        "accept": "application/json",
        "authorization": f"Bearer {api_key}",
    }
    try:
        payload = (
            transport(body, headers, timeout)
            if transport is not None
            else urllib_transport(body, headers, timeout)
        )
    except Exception as exc:  # noqa: BLE001 - optional stage must fail closed
        result.update(
            status="unavailable",
            reason="tts_error",
            error=f"{type(exc).__name__}: {exc}"[:300],
        )
        return result
    audio = ((payload or {}).get("output") or {}).get("audio") or {}
    url = audio.get("url") if isinstance(audio, Mapping) else None
    if not url:
        result.update(status="unavailable", reason="no_audio_url")
        return result
    result.update(
        status="ok",
        url=url,
        expiresAt=audio.get("expires_at"),
        audioId=audio.get("id"),
    )
    return result


def enrich_candidates(
    candidates: Sequence[Mapping[str, Any]] | None,
    *,
    enabled: bool = False,
    transport: ContrastTransport | None = None,
    api_key: str = "",
    limit: int = 3,
) -> dict[str, Any]:
    """Attach ``contrast_audio`` to the first N candidate dicts in place.

    Returns a deterministic summary for the evidence document.  A disabled or
    failing synthesizer leaves the timestamp-only wording intact.
    """
    summary: dict[str, Any] = {
        "enabled": bool(enabled),
        "model": CONTRAST_TTS_MODEL,
        "voice": CONTRAST_TTS_VOICE,
        "attempted": 0,
        "succeeded": 0,
        "unavailable": 0,
    }
    if not enabled:
        return summary
    for item in list(candidates or ())[: max(0, int(limit))]:
        if not isinstance(item, dict):
            continue
        summary["attempted"] += 1
        result = synthesize_word(
            str(item.get("word") or ""),
            enabled=True,
            transport=transport,
            api_key=api_key,
        )
        item["contrast_audio"] = result
        if result.get("status") == "ok":
            summary["succeeded"] += 1
        else:
            summary["unavailable"] += 1
    return summary