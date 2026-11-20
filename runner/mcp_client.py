"""JSON-RPC / HTTP client for Bandroom site requests.

Every request (MCP plus grant GET/PUT) carries the Cloudflare Access service
token headers.  Cloudflare returns a 302 redirect or an HTML login page when
the token is missing or invalid; the application does not guarantee a 401, so
both are treated as authentication failures.

Retry policy is per tool (design §4.4.3 / MJ-8):

* read-only tools, ``renew_review_lease``, ``report_scheduler_heartbeat`` and
  receipt-idempotent completions may be retried with backoff;
* ``claim_review_tasks`` is non-idempotent.  After an ambiguous transport
  failure the caller must first read the receipt/task state or wait for the
  lease; the client never blindly re-sends it.

All network access is through an injectable transport, so tests run offline.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Mapping
from urllib.parse import urljoin

MCP_PROTOCOL_VERSION = "2026-07-28"
SERVICE_ID_HEADER = "CF-Access-Client-Id"
SERVICE_SECRET_HEADER = "CF-Access-Client-Secret"

# Tools whose transport errors may be retried blindly.
RETRYABLE_TOOLS = frozenset(
    {
        "read_study_session",
        "read_speaking_recording",
        "read_recording_bytes",
        "read_review_receipt",
        "renew_review_lease",
        "report_scheduler_heartbeat",
        "complete_review_task",
        # add_coach_feedback deduplicates identical retries server-side and the
        # manual path returns the original receipt, so the same arguments are
        # safe to replay.
        "add_coach_feedback",
    }
)
# Non-idempotent calls: a timeout is ambiguous, do not re-send.
NO_AMBIGUOUS_RETRY_TOOLS = frozenset({"claim_review_tasks"})

_REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})


class McpError(Exception):
    """Base error for site interactions."""


class AuthError(McpError):
    """Cloudflare Access rejected the request (redirect / HTML / 401 / 403)."""


class TransportError(McpError):
    """Transient network or server failure; safe to retry for idempotent tools."""


class AmbiguousCallError(McpError):
    """A non-idempotent call failed without a known outcome."""


class ToolError(McpError):
    """The MCP tool returned ``isError`` with an optional machine code."""

    def __init__(self, message: str, *, code: str | None = None, retryable: bool = False):
        super().__init__(message)
        self.message = message
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes

    def json(self) -> Any:
        try:
            return json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise McpError("response is not valid JSON") from exc


Transport = Callable[[str, str, Mapping[str, str], bytes | None, float], HttpResponse]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


def _header(headers: Mapping[str, str], name: str) -> str:
    lowered = name.lower()
    for key, value in headers.items():
        if key.lower() == lowered:
            return str(value)
    return ""


def _urllib_transport(
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: bytes | None,
    timeout: float,
) -> HttpResponse:
    request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
    # urllib capitalizes header names (Cf-Access-Client-Id); Cloudflare Access
    # service-token validation is case-sensitive. Restore the exact casing.
    request.headers = dict(headers)
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(request, timeout=timeout) as response:
            return HttpResponse(
                status=response.status,
                headers=dict(response.headers.items()),
                body=response.read(),
            )
    except urllib.error.HTTPError as exc:
        return HttpResponse(
            status=exc.code,
            headers=dict(exc.headers.items()) if exc.headers else {},
            body=exc.read(),
        )
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise TransportError(f"site transport failed: {exc}") from exc


class SiteClient:
    """Minimal MCP client plus grant GET/PUT wrapper."""

    def __init__(
        self,
        base_url: str,
        client_id: str,
        client_secret: str,
        *,
        mcp_path: str = "/mcp",
        timeout: float = 30.0,
        retries: int = 3,
        backoff_seconds: float = 1.0,
        sleep: Callable[[float], None] = time.sleep,
        transport: Transport | None = None,
    ):
        if not base_url:
            raise ValueError("base_url is required")
        self.base_url = base_url.rstrip("/") + "/"
        self.mcp_url = urljoin(self.base_url, mcp_path.lstrip("/"))
        self.client_id = client_id
        self.client_secret = client_secret
        self.timeout = timeout
        self.retries = max(0, int(retries))
        self.backoff_seconds = backoff_seconds
        self._sleep = sleep
        self._transport: Transport = transport or _urllib_transport

    # -- HTTP helpers -----------------------------------------------------
    def _service_headers(self, extra: Mapping[str, str] | None = None) -> dict[str, str]:
        headers = {
            SERVICE_ID_HEADER: self.client_id,
            SERVICE_SECRET_HEADER: self.client_secret,
            # Cloudflare edge (error 1010) blocks the default Python-urllib
            # User-Agent; a declared client identity passes.
            "User-Agent": "bandroom-coach-runner/1.0",
        }
        if extra:
            headers.update({key: value for key, value in extra.items()})
        return headers

    def _check_response(
        self, response: HttpResponse, *, expected_json: bool = True
    ) -> None:
        status = response.status
        content_type = _header(response.headers, "content-type").lower()
        prefix = response.body[:1024].lstrip().lower()
        # Cloudflare Access edge behaviour: unauthenticated requests are
        # redirected to a login page, or served an HTML page.  Do not assume
        # the app layer returns 401.
        if status in _REDIRECT_STATUSES:
            raise AuthError("Cloudflare Access redirected the request to sign-in")
        if status in (401, 403):
            raise AuthError(f"Cloudflare Access rejected the service token (HTTP {status})")
        if "text/html" in content_type or prefix.startswith(b"<!doctype html") or prefix.startswith(b"<html"):
            raise AuthError("Cloudflare Access returned an HTML login page")
        if status == 429 or status >= 500:
            raise TransportError(f"site returned HTTP {status}")
        if status >= 400:
            raise McpError(f"site returned HTTP {status}")
        if expected_json and status == 204:
            raise McpError("expected a JSON response, got HTTP 204")

    def _send(
        self,
        method: str,
        url: str,
        *,
        body: bytes | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
        expected_json: bool = True,
    ) -> HttpResponse:
        response = self._transport(
            method, url, self._service_headers(headers), body, timeout or self.timeout
        )
        self._check_response(response, expected_json=expected_json)
        return response

    # -- MCP --------------------------------------------------------------
    def call_tool(
        self,
        name: str,
        arguments: Mapping[str, Any] | None = None,
        *,
        client_run_id: str | None = None,
    ) -> Any:
        """Call one MCP tool and return its decoded text payload."""
        args = dict(arguments or {})
        if client_run_id and name in {
            "report_scheduler_heartbeat",
            "claim_review_tasks",
            "read_review_receipt",
        }:
            args.setdefault("clientRunId", client_run_id)

        request_id = str(uuid.uuid4())
        payload = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": args},
            },
            ensure_ascii=False,
        ).encode("utf-8")
        headers = {
            "content-type": "application/json",
            "accept": "application/json",
            "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        }

        policy_retryable = name in RETRYABLE_TOOLS
        ambiguous_protected = name in NO_AMBIGUOUS_RETRY_TOOLS
        last_error: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                response = self._send("POST", self.mcp_url, body=payload, headers=headers)
                return self._parse_rpc(response)
            except AuthError:
                raise
            except TransportError as exc:
                last_error = exc
                if ambiguous_protected:
                    raise AmbiguousCallError(
                        f"{name} outcome is ambiguous after a transport failure; "
                        "read the receipt/task state before retrying"
                    ) from exc
                if not policy_retryable or attempt >= self.retries:
                    raise
                self._sleep(self.backoff_seconds * (2**attempt))
            except McpError:
                raise
        assert last_error is not None
        raise last_error

    def _parse_rpc(self, response: HttpResponse) -> Any:
        message = response.json()
        if not isinstance(message, dict):
            raise McpError("MCP response is not an object")
        if message.get("error") is not None:
            error = message["error"]
            text = error.get("message", "MCP error") if isinstance(error, dict) else str(error)
            raise ToolError(str(text), code=str(error.get("code")) if isinstance(error, dict) else None)
        result = message.get("result")
        if not isinstance(result, dict):
            raise McpError("MCP response has no result")
        content = result.get("content")
        texts: list[str] = []
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    texts.append(str(item.get("text", "")))
        combined = "".join(texts)
        if result.get("isError"):
            code = None
            retryable = False
            try:
                parsed = json.loads(combined)
                if isinstance(parsed, dict):
                    code = parsed.get("error")
                    retryable = bool(parsed.get("retryable"))
            except (json.JSONDecodeError, TypeError):
                pass
            raise ToolError(combined or "MCP tool failed", code=code, retryable=retryable)
        if not combined:
            return None
        try:
            return json.loads(combined)
        except json.JSONDecodeError:
            return combined

    # -- Grant GET/PUT ----------------------------------------------------
    def _binary_request(
        self,
        method: str,
        url: str,
        *,
        body: bytes | None = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> bytes:
        """Send a grant-bound binary request; classify 4xx error codes.

        The review-transfer route returns ``{error: code, retryable?}`` JSON on
        failure. Surface the machine code as a ToolError so the orchestrator can
        classify permanent transfer failures (artifact_conflict,
        invalid_decode_checkpoint, transfer_expired, ...) instead of treating
        every 4xx as a generic retryable transport error (iteration-31 U-MJ-5).
        """
        extra = {"accept": "*/*"}
        if headers:
            extra.update(headers)
        response = self._transport(
            method, url, self._service_headers(extra), body, timeout or self.timeout
        )
        status = response.status
        if status in _REDIRECT_STATUSES or status in (401, 403):
            self._check_response(response, expected_json=False)  # raises AuthError
        if status == 429 or status >= 500:
            raise TransportError(f"site returned HTTP {status}")
        if status >= 400:
            code = None
            retryable = False
            try:
                parsed = response.json()
                if isinstance(parsed, dict):
                    code = parsed.get("error")
                    retryable = bool(parsed.get("retryable"))
            except McpError:
                pass
            raise ToolError(
                f"review-transfer HTTP {status}: {code or 'error'}",
                code=str(code) if code else None,
                retryable=retryable,
            )
        return response.body

    def get_bytes(
        self, url: str, *, headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> bytes:
        """GET a signed grant URL with the service token headers attached."""
        return self._binary_request("GET", url, headers=headers, timeout=timeout)

    def put_bytes(
        self,
        url: str,
        body: bytes,
        *,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> bytes:
        """PUT a signed grant URL with the service token headers attached."""
        extra = {"content-type": "application/octet-stream"}
        if headers:
            extra = {**extra, **headers}
        return self._binary_request("PUT", url, body=body, headers=extra, timeout=timeout)