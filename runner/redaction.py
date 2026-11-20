"""Shared log redaction for runner error detail.

Exception text can contain access tokens, API keys, or other credentials echoed
by an upstream error. Log only a redacted, length-bounded detail. Kept in a
lightweight module so grounded_audio can use it without importing orchestrator
(which imports grounded_audio — a cycle).
"""
from __future__ import annotations

import re

_SECRET_PATTERN = re.compile(
    r"(?i)(authorization|bearer|api[_-]?key|access[_-]?token|refresh[_-]?token"
    r"|token|secret|password|passphrase)\s*[:=]?\s*\S+"
)


def redact_error_detail(text: str, limit: int = 300) -> str:
    """Redact secret-looking substrings and bound the detail length."""
    # "Bearer <token>" first: the generic pattern only consumes one token and
    # would leave the credential behind.
    cleaned = re.sub(r"(?i)\bbearer\s+\S+", "Bearer [REDACTED]", str(text))
    cleaned = _SECRET_PATTERN.sub(r"\1: [REDACTED]", cleaned)
    return cleaned[-limit:]