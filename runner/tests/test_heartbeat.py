from __future__ import annotations

import pytest

from runner.orchestrator import (
    HEARTBEAT_KEYS,
    heartbeat_payload,
    validate_heartbeat,
)


def test_heartbeat_exact_server_contract():
    payload = heartbeat_payload(
        automation_id="bandroom-coach-runner",
        generation=3,
        client_run_id="11111111-2222-3333-4444-555555555555",
        status="finished",
        started_at=1000,
        finished_at=2000,
        next_expected_at=301000,
        detail="processed=1 failed=0 blocked=0",
    )
    assert set(payload) == HEARTBEAT_KEYS
    assert set(payload) == {
        "automationId",
        "generation",
        "clientRunId",
        "status",
        "startedAt",
        "finishedAt",
        "nextExpectedAt",
        "detail",
    }
    # No lastSuccessAt / degraded in the actual contract.
    assert "lastSuccessAt" not in payload
    assert "degraded" not in payload


def test_heartbeat_rejects_extra_keys_and_bad_status():
    payload = heartbeat_payload(
        automation_id="runner",
        generation=1,
        client_run_id="run",
        status="started",
        started_at=1,
    )
    payload["lastSuccessAt"] = 1
    with pytest.raises(ValueError):
        validate_heartbeat(payload)

    with pytest.raises(ValueError):
        heartbeat_payload(
            automation_id="runner",
            generation=1,
            client_run_id="run",
            status="degraded",
            started_at=1,
        )


def test_heartbeat_detail_limit():
    with pytest.raises(ValueError):
        heartbeat_payload(
            automation_id="runner",
            generation=1,
            client_run_id="run",
            status="failed",
            started_at=1,
            detail="x" * 501,
        )