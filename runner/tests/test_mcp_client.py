from __future__ import annotations

import json

import pytest

from runner.mcp_client import (
    SERVICE_ID_HEADER,
    SERVICE_SECRET_HEADER,
    AmbiguousCallError,
    AuthError,
    HttpResponse,
    McpError,
    SiteClient,
    ToolError,
    TransportError,
)


def _rpc(text, *, is_error=False):
    return HttpResponse(
        200,
        {"content-type": "application/json"},
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": "x",
                "result": {
                    "content": [{"type": "text", "text": text}],
                    **({"isError": True} if is_error else {}),
                },
            }
        ).encode(),
    )


class Recorder:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append(
            {"method": method, "url": url, "headers": dict(headers), "body": body, "timeout": timeout}
        )
        item = self.responses.pop(0)
        if isinstance(item, BaseException):
            raise item
        return item


def _client(recorder, *, retries=2):
    return SiteClient(
        "https://bandroom.example.test",
        "client-id",
        "client-secret",
        retries=retries,
        backoff_seconds=0.01,
        sleep=lambda _: None,
        transport=recorder,
    )


def test_redirect_is_authentication_failure():
    recorder = Recorder(
        [HttpResponse(302, {"location": "https://team.cloudflareaccess.com/login"}, b"")]
    )
    with pytest.raises(AuthError):
        _client(recorder).call_tool("read_study_session", {})


def test_html_login_page_is_authentication_failure():
    recorder = Recorder(
        [HttpResponse(200, {"content-type": "text/html"}, b"<!doctype html><html>login</html>")]
    )
    with pytest.raises(AuthError):
        _client(recorder).call_tool("read_study_session", {})


def test_403_is_authentication_failure_without_retry():
    recorder = Recorder([HttpResponse(403, {"content-type": "application/json"}, b"{}")])
    with pytest.raises(AuthError):
        _client(recorder).call_tool("read_study_session", {})
    assert len(recorder.calls) == 1


def test_every_request_carries_service_token_headers():
    recorder = Recorder(
        [
            _rpc('{"ok": true}'),
            HttpResponse(200, {"content-type": "application/octet-stream"}, b"raw"),
            HttpResponse(200, {"content-type": "application/json"}, b"{}"),
        ]
    )
    client = _client(recorder)
    client.call_tool("read_study_session", {})
    client.get_bytes("https://bandroom.example.test/grant/decode")
    client.put_bytes("https://bandroom.example.test/grant/decode", b"data")
    for call in recorder.calls:
        assert call["headers"][SERVICE_ID_HEADER] == "client-id"
        assert call["headers"][SERVICE_SECRET_HEADER] == "client-secret"


def test_heartbeat_is_retried_with_backoff():
    sleeps = []
    recorder = Recorder(
        [
            TransportError("temporary"),
            HttpResponse(503, {"content-type": "application/json"}, b"{}"),
            _rpc('{"ok": true}'),
        ]
    )
    client = SiteClient(
        "https://bandroom.example.test",
        "id",
        "secret",
        retries=3,
        backoff_seconds=0.5,
        sleep=sleeps.append,
        transport=recorder,
    )
    assert client.call_tool("report_scheduler_heartbeat", {"automationId": "a"}) == {"ok": True}
    assert len(recorder.calls) == 3
    assert sleeps == [0.5, 1.0]


def test_claim_is_not_retried_on_ambiguous_transport_failure():
    recorder = Recorder([TransportError("timeout")])
    client = _client(recorder, retries=5)
    with pytest.raises(AmbiguousCallError):
        client.call_tool("claim_review_tasks", {"limit": 1})
    assert len(recorder.calls) == 1


def test_add_coach_feedback_replays_safely():
    recorder = Recorder([TransportError("timeout"), _rpc('{"saved": true}')])
    result = _client(recorder).call_tool("add_coach_feedback", {"attempt": "v1:x"})
    assert result == {"saved": True}
    assert len(recorder.calls) == 2


def test_read_only_tool_retries_500():
    recorder = Recorder(
        [
            HttpResponse(500, {"content-type": "application/json"}, b"{}"),
            _rpc('{"day": 12}'),
        ]
    )
    assert _client(recorder).call_tool("read_study_session", {}) == {"day": 12}
    assert len(recorder.calls) == 2


def test_tool_error_payload_is_classified():
    recorder = Recorder(
        [
            _rpc(
                '{"error": "stale_lease", "retryable": false}',
                is_error=True,
            )
        ]
    )
    with pytest.raises(ToolError) as caught:
        _client(recorder).call_tool("add_coach_feedback", {})
    assert caught.value.code == "stale_lease"


def test_client_run_id_injected_for_heartbeat_and_claim():
    recorder = Recorder([_rpc('{"ok": true}'), _rpc('{"tasks": []}')])
    client = _client(recorder)
    client.call_tool(
        "report_scheduler_heartbeat",
        {"automationId": "runner"},
        client_run_id="run-uuid",
    )
    client.call_tool("claim_review_tasks", {"limit": 1}, client_run_id="run-uuid")
    bodies = [json.loads(call["body"].decode()) for call in recorder.calls]
    assert bodies[0]["params"]["arguments"]["clientRunId"] == "run-uuid"
    assert bodies[1]["params"]["arguments"]["clientRunId"] == "run-uuid"


def test_redirect_on_grant_get_is_auth_failure():
    recorder = Recorder([HttpResponse(302, {"location": "/login"}, b"")])
    with pytest.raises(AuthError):
        _client(recorder).get_bytes("https://bandroom.example.test/grant")


def test_grant_put_accepts_empty_204():
    recorder = Recorder([HttpResponse(204, {}, b"")])
    assert _client(recorder).put_bytes("https://bandroom.example.test/grant", b"x") == b""
    assert recorder.calls[0]["method"] == "PUT"
    assert recorder.calls[0]["headers"][SERVICE_ID_HEADER] == "client-id"


def test_rpc_error_object_raises_tool_error():
    recorder = Recorder(
        [
            HttpResponse(
                200,
                {"content-type": "application/json"},
                json.dumps({"jsonrpc": "2.0", "id": "x", "error": {"code": -32602, "message": "bad"}}).encode(),
            )
        ]
    )
    with pytest.raises(ToolError):
        _client(recorder).call_tool("read_study_session", {})