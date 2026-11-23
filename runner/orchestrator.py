"""Production coach-track orchestrator.

Entry points
------------
``python3 -m runner.orchestrator --config runner/config.toml``
``python3 -m runner.orchestrator --dry-run`` (mock client/model, no network)

Flow (design §4.4.1): flock single instance; read_study_session; serially
review each pending subjective attempt; text via qwen3.8-max; speaking via
bytes-mode recording reassembly + whole-clip mp3 transcode + qwen3.8-omni-flash
with a provisional pronunciation rating; write back with add_coach_feedback.
Model calls happen before the server's internal claim, so no review lease is
held during inference.

Failures are classified and retried on the next run (persisted state), except
permanent audio/content errors, which are blocked from repeated attempts.
Heartbeats use the exact server contract and the cost cap spans text + audio.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import fcntl
import json
import logging
import os
import signal
import tempfile
import time
import tomllib
import uuid
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping

from . import audio as audio_module
from . import grounded_audio
from .audio import AudioError, PreparedAudio
from .content_rules import (
    PROMPT_VERSION,
    ContentRuleError,
    ValidatedFeedback,
    feedback_to_tool_args,
    validate_feedback,
)
from .grounded_audio import GroundedConfig
from .mcp_client import (
    AuthError,
    McpError,
    SiteClient,
    ToolError,
    TransportError,
)
from .models import Feedback, ModelError, build_model
from .models.base import CoachModel
from .models.qwen import DASHSCOPE_BASE_URL
from .tenant_queue import (
    MICRO,
    PermanentTaskError,
    TaskYielded,
    UserBudget,
    run_one,
)

LOG = logging.getLogger("bandroom.runner")

HEARTBEAT_KEYS = frozenset(
    {
        "automationId",
        "generation",
        "clientRunId",
        "status",
        "startedAt",
        "finishedAt",
        "nextExpectedAt",
        "detail",
    }
)
HEARTBEAT_STATUSES = frozenset({"started", "finished", "failed"})

PERMANENT_AUDIO_CODES = frozenset(
    {
        "audio_too_long",
        "audio_encoded_too_large",
        "invalid_audio",
        "recording_too_large",
        "recording_sha256_mismatch",
        "recording_size_mismatch",
        "recording_empty",
        "ffmpeg_unavailable",
        "ffprobe_unavailable",
    }
)
# Server codes that mean "try again next run after re-reading state".
RETRYABLE_TOOL_CODES = frozenset(
    {
        "stale_lease",
        "task_not_found",
        "recording_read_failed",
        "recording_range_truncated",
        "transfer_storage_unavailable",
    }
)

# Server messages that indicate a transient write race (the learner submitted
# again between our session read and the writeback). The next run re-reads the
# session, so these must not block the attempt. Exact strings from
# lib/coach.ts add_coach_feedback.
TRANSIENT_TOOL_MESSAGES = (
    "Read study_session again and use the new exact attempt ID.",
    "Another writer kept taking this review.",
)

# Provider/transport exceptions can embed request headers or key fragments.
# Error details are persisted (state) and written to logs, so redact common
# secret shapes before either sink. Shared with grounded_audio (no import cycle).
from .redaction import redact_error_detail


# Queue-path speaking completion contract gap (iteration-30, owner decision A).
# complete_review_task gates speaking completions on a RELEASED analysis version
# plus a committed decoded-PCM checkpoint (the QA acoustic-track contract,
# lib/review-tools.ts:246-296). The grounded prosody producer does not emit that
# contract and prod has no ANALYSIS_RELEASED_VERSIONS, so these rejections are
# deterministic: retrying cannot fix them. Classify NON-retryable (block once,
# fail-closed) instead of burning claim attempts. This is a disclosed pre-enable
# blocker for multi_tenant speaking, NOT a threshold change. See
# acceptance-2026-11-10/iteration-30/P2B_ORCHESTRATOR_WIRING_PLAN.md.
QUEUE_PERMANENT_CODES = frozenset(
    {
        "analysis_not_released",
        "analysis_version_required",
        "analysis_version_mismatch",
        "checkpoint_missing",
        "checkpoint_not_read",
        "invalid_analysis",
        "analysis_required",
        "analysis_not_allowed",
        "content_rule_violation",
        "snapshot_invalid",
        # Deterministic decoded-checkpoint transfer failures (rev3 U-MJ-5):
        # retrying identical bytes cannot fix these.
        "artifact_conflict",
        "invalid_decode_checkpoint",
        "transfer_expired",
        "checkpoint_advanced",
        "decoded_too_long",
        "recording_mismatch",
        "recording_digest_unavailable",
    }
)

# Audio dispatch modes.  Precedence (documented in GROUNDED_AUDIO_INTEGRATION.md):
# 1. an explicit ``[runner] coach_audio_mode`` wins;
# 2. when the key is absent, the legacy ``coach_audio`` boolean decides:
#    true -> "legacy", false -> "off";
# 3. shipped config files set coach_audio_mode = "off" explicitly.
COACH_AUDIO_MODES = frozenset({"off", "legacy", "grounded"})


def resolve_coach_audio_mode(config: "RunnerConfig") -> str:
    mode = config.coach_audio_mode
    if mode is not None:
        value = str(mode).strip().lower()
        if value not in COACH_AUDIO_MODES:
            raise ConfigError(f"unknown coach_audio_mode: {mode!r}")
        return value
    return "legacy" if config.coach_audio else "off"


class ConfigError(Exception):
    pass


class AlreadyRunning(Exception):
    pass


@dataclass
class RunnerConfig:
    base_url: str = "https://bandroom.example.com"
    mcp_path: str = "/mcp"
    client_id: str = "test-client-id"
    client_secret: str = "test-client-secret"
    site_timeout: float = 30.0
    site_retries: int = 3
    provider: str = "qwen"
    api_key: str = "test-api-key"
    model_base_url: str = DASHSCOPE_BASE_URL
    text_model: str = "qwen3.8-max"
    audio_model: str = "qwen3.8-omni-flash"
    text_timeout: float = 120.0
    # Grounded feedback is a long plain-text generation; the research build
    # measured 77-162 s, so the shipped 120 s text timeout produced tail
    # failures.  This separate budget is config-driven and clamped to
    # [240, 300] s.  p95 must still be measured before enabling.
    grounded_text_timeout: float = grounded_audio.GROUNDED_TEXT_TIMEOUT_SECONDS
    audio_timeout: float = 240.0
    # F14: transient provider failures retry at the model layer (429/5xx /
    # transport) before raising a retryable ModelError; a consecutive-failure
    # circuit breaker then fails fast for a cooldown so queued tasks requeue.
    model_max_retries: int = 3
    model_backoff_base_seconds: float = 1.0
    circuit_breaker_threshold: int = 5
    circuit_breaker_cooldown_seconds: float = 60.0
    automation_id: str = "bandroom-coach-runner"
    generation: int = 1
    interval_seconds: int = 300
    daily_cap_cny: float = 20.0
    text_cost_cny: float = 0.05
    audio_cost_cny: float = 0.20
    # F3: canonical TTS contrast audio is billed per synthesis call. DashScope
    # does not publish a per-call price in this contract; this is a conservative
    # ESTIMATE that must be reconciled with the provider console.
    tts_cost_cny: float = 0.02
    max_attempts: int = 3
    state_dir: Path = field(default_factory=lambda: Path("~/.bandroom-runner"))
    chunk_bytes: int = 24576
    max_recording_bytes: int = 12 * 1024 * 1024
    max_duration_seconds: int = audio_module.MAX_DURATION_SECONDS
    transcode_bitrates_kbps: tuple[int, ...] = audio_module.DEFAULT_BITRATES_KBPS
    prompt_version: str = PROMPT_VERSION
    # Gate-1 ruling (2026-11-15, owner): text coach passed, audio coach held
    # (safe but below Work baseline). When False, speaking attempts are skipped.
    coach_audio: bool = True
    # "off" | "legacy" | "grounded".  None means "not configured": fall back to
    # the legacy coach_audio boolean (true -> legacy, false -> off) so existing
    # config files keep their exact behaviour.
    coach_audio_mode: str | None = None
    grounded: GroundedConfig = field(default_factory=GroundedConfig)
    grounded_cost_cny: float = 0.10
    # Queue-path grounded-prosody analysis version (iteration-31 rev3). Must match
    # the Worker's GROUNDED_ANALYSIS_VERSION / GROUNDED_RELEASED_VERSIONS so the
    # decoded-checkpoint manifest and complete_review_task bind the same version.
    grounded_analysis_version: str = "grounded-prosody-v1"
    # Multi-tenant queue path (P2b, iteration-30 wiring plan). Default OFF: the
    # single-owner run() path is byte-for-byte unchanged until the owner enables
    # it. When True, run() forks to run_multi_tenant() which claims cross-tenant
    # tasks via claim_next_review_task and completes via complete_review_task.
    multi_tenant: bool = False
    tenant_per_user_cap_cny: float = 2.0
    tenant_global_cap_cny: float | None = None
    tenant_client_run_id: str = "runner"
    # Fairness (F11): after this many CONSECUTIVE processed tasks for one user,
    # the next claim for that user is yielded retryably so other tenants' due
    # tasks are served first. MVP batch cap (server LRU cursor is a later step).
    tenant_batch_cap: int = 3
    # MT-5 (G4 / license gate): the deployment owner userId. The NC-licensed
    # detector (Stage B) and commercial TTS run ONLY for entitled tenants. The
    # owner is entitled by the single-owner personal-use posture; other tenants
    # need an explicit entitlement (carried in the claim response, or granted via
    # /api/admin/entitlements). Default empty → detector/TTS fail closed for all.
    owner_user_id: str = ""

    def resolved_state_dir(self) -> Path:
        return Path(os.path.expanduser(str(self.state_dir)))


def _env(env_name: str | None, default_name: str) -> str:
    return os.environ.get(env_name or default_name, "")


def load_config(path: str | Path) -> RunnerConfig:
    """Load TOML config; secrets only ever come from environment variables."""
    raw = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    site = raw.get("site", {})
    model = raw.get("model", {})
    runner = raw.get("runner", {})
    budget = raw.get("budget", {})
    audio_config = raw.get("audio", {})
    grounded_config = raw.get("grounded", {})

    client_id = _env(site.get("client_id_env"), "BANDROOM_RUNNER_CLIENT_ID")
    client_secret = _env(site.get("client_secret_env"), "BANDROOM_RUNNER_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise ConfigError("runner service token is not configured in the environment")
    provider = model.get("provider", "qwen")
    api_key = _env(model.get("api_key_env"), "DASHSCOPE_API_KEY")
    if provider == "qwen" and not api_key:
        raise ConfigError("DASHSCOPE_API_KEY is not configured")

    mode = runner.get("coach_audio_mode")
    if mode is not None:
        mode = str(mode).strip().lower()
        if mode not in COACH_AUDIO_MODES:
            raise ConfigError(
                f"coach_audio_mode must be one of {sorted(COACH_AUDIO_MODES)}"
            )
    try:
        grounded = GroundedConfig.from_mapping(grounded_config)
    except (TypeError, ValueError) as exc:
        raise ConfigError(f"invalid [grounded] config: {exc}") from exc
    if grounded.self_listen_max_n < 0:
        raise ConfigError("[grounded] self_listen_max_n must be >= 0")

    grounded_text_timeout = float(
        model.get(
            "grounded_text_timeout_seconds",
            grounded_audio.GROUNDED_TEXT_TIMEOUT_SECONDS,
        )
    )
    if not (
        grounded_audio.GROUNDED_TEXT_TIMEOUT_MIN
        <= grounded_text_timeout
        <= grounded_audio.GROUNDED_TEXT_TIMEOUT_MAX
    ):
        raise ConfigError(
            "[model] grounded_text_timeout_seconds must be in "
            f"[{grounded_audio.GROUNDED_TEXT_TIMEOUT_MIN:.0f}, "
            f"{grounded_audio.GROUNDED_TEXT_TIMEOUT_MAX:.0f}] s"
        )

    return RunnerConfig(
        base_url=site.get("base_url", "https://bandroom.example.com"),
        mcp_path=site.get("mcp_path", "/mcp"),
        client_id=client_id,
        client_secret=client_secret,
        site_timeout=float(site.get("timeout_seconds", 30)),
        site_retries=int(site.get("retries", 3)),
        provider=provider,
        api_key=api_key,
        model_base_url=model.get("base_url", DASHSCOPE_BASE_URL),
        text_model=model.get("text_model", "qwen3.8-max"),
        audio_model=model.get("audio_model", "qwen3.8-omni-flash"),
        text_timeout=float(model.get("text_timeout_seconds", 120)),
        grounded_text_timeout=grounded_text_timeout,
        audio_timeout=float(model.get("audio_timeout_seconds", 240)),
        model_max_retries=int(model.get("model_max_retries", 3)),
        model_backoff_base_seconds=float(model.get("model_backoff_base_seconds", 1.0)),
        circuit_breaker_threshold=int(model.get("circuit_breaker_threshold", 5)),
        circuit_breaker_cooldown_seconds=float(
            model.get("circuit_breaker_cooldown_seconds", 60.0)
        ),
        automation_id=runner.get("automation_id", "bandroom-coach-runner"),
        generation=int(runner.get("generation", 1)),
        interval_seconds=int(runner.get("interval_seconds", 300)),
        daily_cap_cny=float(budget.get("daily_cap_cny", 20)),
        text_cost_cny=float(budget.get("text_cost_cny", 0.05)),
        audio_cost_cny=float(budget.get("audio_cost_cny", 0.20)),
        tts_cost_cny=float(budget.get("tts_cost_cny", 0.02)),
        max_attempts=int(runner.get("max_attempts", 3)),
        coach_audio=bool(runner.get("coach_audio", True)),
        coach_audio_mode=mode,
        grounded=grounded,
        grounded_cost_cny=float(budget.get("grounded_cost_cny", 0.10)),
        grounded_analysis_version=str(
            runner.get("grounded_analysis_version", "grounded-prosody-v1")
        ),
        multi_tenant=bool(runner.get("multi_tenant", False)),
        tenant_per_user_cap_cny=float(runner.get("tenant_per_user_cap_cny", 2.0)),
        tenant_global_cap_cny=(
            float(runner["tenant_global_cap_cny"])
            if runner.get("tenant_global_cap_cny") is not None
            else None
        ),
        tenant_client_run_id=str(runner.get("tenant_client_run_id", "runner")),
        tenant_batch_cap=int(runner.get("tenant_batch_cap", 3)),
        owner_user_id=str(runner.get("owner_user_id", "")),
        state_dir=Path(
            os.path.expanduser(runner.get("state_dir", "~/.bandroom-runner"))
        ),
        chunk_bytes=int(audio_config.get("chunk_bytes", 24576)),
        max_recording_bytes=int(
            audio_config.get("max_recording_bytes", 12 * 1024 * 1024)
        ),
        max_duration_seconds=int(
            audio_config.get("max_duration_seconds", audio_module.MAX_DURATION_SECONDS)
        ),
        transcode_bitrates_kbps=tuple(
            int(value)
            for value in audio_config.get(
                "transcode_bitrates_kbps", list(audio_module.DEFAULT_BITRATES_KBPS)
            )
        ),
        prompt_version=PROMPT_VERSION,
    )


class StateStore:
    """Small atomic JSON state file (cost ledger, retry/blocked attempts)."""

    SCHEMA = 1

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.data = self._load()

    def _empty(self) -> dict[str, Any]:
        return {
            "schema": self.SCHEMA,
            "cost": {"utcDay": "", "spentCny": 0.0, "paused": False},
            "attempts": {},
            "lastRun": None,
        }

    def _load(self) -> dict[str, Any]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return self._empty()
        if not isinstance(value, dict) or value.get("schema") != self.SCHEMA:
            return self._empty()
        value.setdefault("cost", {"utcDay": "", "spentCny": 0.0, "paused": False})
        value.setdefault("attempts", {})
        return value

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_text(
            json.dumps(self.data, ensure_ascii=False, sort_keys=True), encoding="utf-8"
        )
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        os.replace(temporary, self.path)

    def ensure_day(self, utc_day: str) -> None:
        cost = self.data["cost"]
        if cost.get("utcDay") != utc_day:
            cost.update({"utcDay": utc_day, "spentCny": 0.0, "paused": False})
            self.save()

    def paused(self) -> bool:
        return bool(self.data["cost"].get("paused"))

    def reserve_cost(self, cost_cny: float, cap_cny: float) -> bool:
        cost = self.data["cost"]
        if cap_cny and cap_cny > 0 and float(cost.get("spentCny", 0.0)) + cost_cny > cap_cny + 1e-9:
            cost["paused"] = True
            self.save()
            return False
        cost["spentCny"] = round(float(cost.get("spentCny", 0.0)) + cost_cny, 6)
        self.save()
        return True

    def attempt(self, attempt_id: str) -> dict[str, Any]:
        return self.data["attempts"].setdefault(
            attempt_id, {"failures": 0, "blocked": False, "lastError": None}
        )

    def is_blocked(self, attempt_id: str) -> bool:
        return bool(self.data["attempts"].get(attempt_id, {}).get("blocked"))

    def note_failure(
        self, attempt_id: str, code: str, *, retryable: bool, max_attempts: int
    ) -> bool:
        record = self.attempt(attempt_id)
        record["failures"] = int(record.get("failures", 0)) + 1
        record["lastError"] = code
        if not retryable or record["failures"] >= max_attempts:
            record["blocked"] = True
        self.save()
        return bool(record["blocked"])

    def mark_success(self, attempt_id: str) -> None:
        self.data["attempts"].pop(attempt_id, None)
        self.save()

    def clear_blocks(self) -> None:
        self.data["attempts"] = {}
        self.data["cost"]["paused"] = False
        self.save()

    def set_last_run(self, value: Mapping[str, Any]) -> None:
        self.data["lastRun"] = dict(value)
        self.save()


@dataclass
class RunReport:
    run_id: str
    processed: int = 0
    failed: int = 0
    skipped_blocked: int = 0
    paused: bool = False
    fatal: bool = False
    detail: str = ""
    errors: list[dict[str, Any]] = field(default_factory=list)
    # Multi-tenant queue counters (additive; zero on the single-owner path).
    capped: int = 0
    yielded: int = 0
    blocked: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# Phase 0 (docs/experience-upgrade-realtime-feedback-revision-2026-11-22.md §4.2):
# an always-on runner replaces the 300 s launchd cadence. Idle cycles back off
# 2 -> 4 -> 8 -> 10 s; any work resets to 2 s. Heartbeats are decoupled from
# claims (about one per minute while idle), and the process exits after a
# bounded lifetime so launchd (KeepAlive) restarts it fresh with reloaded
# config and credentials.
DAEMON_IDLE_BACKOFF_SECONDS: tuple[float, ...] = (2.0, 4.0, 8.0, 10.0)
DAEMON_HEARTBEAT_SECONDS = 60.0
DAEMON_PAUSED_SLEEP_SECONDS = 300.0
DAEMON_ERROR_SLEEP_SECONDS = 30.0
DAEMON_AUTH_FAILURE_SLEEP_SECONDS = 300.0
DAEMON_MAX_RUNTIME_SECONDS = 6 * 3600.0
DAEMON_MAX_TASKS = 200


@dataclass
class DaemonReport:
    cycles: int = 0
    processed: int = 0
    failed: int = 0
    exit_reason: str = ""
    fatal: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {"daemon": True, **asdict(self)}


def daemon_idle_delay(idle_cycles: int) -> float:
    """Idle backoff for the always-on runner (bounded at 10 s)."""
    index = min(max(0, idle_cycles), len(DAEMON_IDLE_BACKOFF_SECONDS) - 1)
    return DAEMON_IDLE_BACKOFF_SECONDS[index]


@dataclass
class Produced:
    """A validated review ready to be persisted, independent of the save path.

    The single-owner path saves via ``add_coach_feedback`` (``owner_args``); the
    queue path saves via ``complete_review_task`` (``complete_args``). Extracting
    production from persistence lets both paths share the exact model + content
    rule logic without the queue path re-using the owner-only manual-claim save.
    """

    validated: ValidatedFeedback
    day: int
    stage: str
    recording_id: str | None = None
    recording_sha256: str | None = None
    audio_used: bool = False
    # Queue-path grounded-prosody wire analysis (rev3). When present, complete_args
    # sends it (server validates via validateGroundedAnalysis); the owner path
    # ignores it and uses validated.analysis (feedbackSpec.groundedAnalysis shape).
    queue_analysis: Mapping[str, Any] | None = None

    def owner_args(self) -> dict[str, Any]:
        return feedback_to_tool_args(
            self.validated,
            day=self.day,
            stage=self.stage,
            recording_id=self.recording_id,
            audio_used=self.audio_used,
        )

    def complete_args(
        self, task_id: str, fence: int, *, analysis_version: str | None = None
    ) -> dict[str, Any]:
        args: dict[str, Any] = {
            "taskId": task_id,
            "fence": int(fence),
            "feedback": self.validated.feedback,
            "evidence": self.validated.evidence,
        }
        if self.recording_sha256:
            args["recordingSha256"] = self.recording_sha256
        analysis = self.queue_analysis if self.queue_analysis is not None else self.validated.analysis
        if analysis is not None:
            args["analysis"] = dict(analysis)
        version = analysis_version
        if version is None and self.queue_analysis is not None:
            version = str(self.queue_analysis.get("analysisVersion") or "") or None
        if version:
            args["analysisVersion"] = version
        # The grounded-prosody class emits no pronunciation band (T2 retired).
        if self.queue_analysis is None and self.validated.pronunciation is not None and self.recording_id:
            args["pronunciation"] = {
                "band": self.validated.pronunciation.band,
                "reviewedWholeClip": True,
                "observation": self.validated.pronunciation.observation,
                "recordingId": self.recording_id,
            }
        return args


def heartbeat_payload(
    *,
    automation_id: str,
    generation: int,
    client_run_id: str,
    status: str,
    started_at: int | None,
    finished_at: int | None = None,
    next_expected_at: int | None = None,
    detail: str | None = None,
) -> dict[str, Any]:
    payload = {
        "automationId": automation_id,
        "generation": int(generation),
        "clientRunId": client_run_id,
        "status": status,
        "startedAt": started_at,
        "finishedAt": finished_at,
        "nextExpectedAt": next_expected_at,
        "detail": detail,
    }
    # Server schema (lib/review-tools.ts:88-97): startedAt/finishedAt/
    # nextExpectedAt are optional NUMBERS, not nullable — omit when None.
    # detail is nullable/optional; omit when None for cleanliness.
    payload = {k: v for k, v in payload.items() if v is not None}
    validate_heartbeat(payload)
    return payload


def validate_heartbeat(payload: Mapping[str, Any]) -> None:
    """Enforce the exact server contract (lib/review-tools.ts:88-97)."""
    keys = set(payload)
    required = {"automationId", "generation", "clientRunId", "status"}
    if not required <= keys <= HEARTBEAT_KEYS:
        missing = required - keys
        extra = keys - HEARTBEAT_KEYS
        raise ValueError(f"heartbeat keys invalid (missing={sorted(missing)}, extra={sorted(extra)})")
    if payload["status"] not in HEARTBEAT_STATUSES:
        raise ValueError("heartbeat status must be started|finished|failed")
    if not isinstance(payload["automationId"], str) or not payload["automationId"]:
        raise ValueError("heartbeat automationId is required")
    if not isinstance(payload["clientRunId"], str) or not payload["clientRunId"]:
        raise ValueError("heartbeat clientRunId is required")
    if not isinstance(payload["generation"], int) or payload["generation"] < 0:
        raise ValueError("heartbeat generation must be a non-negative integer")
    # Optional number fields: when present must be a non-negative int (NOT null;
    # null is omitted by heartbeat_payload to match the server's optional schema).
    for key in ("startedAt", "finishedAt", "nextExpectedAt"):
        if key in payload:
            value = payload[key]
            if not isinstance(value, int) or value < 0:
                raise ValueError(f"heartbeat {key} must be a non-negative integer")
    if "detail" in payload:
        detail = payload["detail"]
        if not isinstance(detail, str):
            raise ValueError("heartbeat detail must be a string")
        if len(detail.strip()) > 500:
            raise ValueError("heartbeat detail exceeds 500 characters")


def _error_code(exc: BaseException) -> str:
    for attribute in ("code",):
        value = getattr(exc, attribute, None)
        if isinstance(value, str) and value:
            return value
    if isinstance(exc, AuthError):
        return "auth_failed"
    if isinstance(exc, TransportError):
        return "transport_error"
    return exc.__class__.__name__.lower()


@contextlib.contextmanager
def single_instance_lock(lock_path: str | Path):
    """flock-based single-instance guard; held for the whole run."""
    path = Path(lock_path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    handle = open(path, "a+", encoding="utf-8")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise AlreadyRunning("another coach runner instance holds the lock") from exc
        yield
    finally:
        with contextlib.suppress(OSError):
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


class CoachRunner:
    def __init__(
        self,
        config: RunnerConfig,
        *,
        client: Any | None = None,
        model: CoachModel | None = None,
        prepare_audio: Callable[..., PreparedAudio] = audio_module.prepare_audio,
        clock: Callable[[], float] = time.time,
        logger: logging.Logger | None = None,
    ):
        self.config = config
        self.state = StateStore(config.resolved_state_dir() / "state.json")
        self.client = client or SiteClient(
            config.base_url,
            config.client_id,
            config.client_secret,
            mcp_path=config.mcp_path,
            timeout=config.site_timeout,
            retries=config.site_retries,
        )
        self.model = model if model is not None else build_model(config)
        self.prepare_audio = prepare_audio
        self._clock = clock
        self._logger = logger or LOG
        # Multi-tenant queue state (populated by run_multi_tenant; defaults keep
        # _process_queue_task safe to call directly in tests).
        self._queue_run_id = "runner"
        self._tenant_budget: UserBudget | None = None
        self._fair_last_user: str | None = None
        self._fair_run_length = 0
        # F9 progress heartbeats: keep nextExpectedAt honest during a long run.
        self._queue_started_at = 0
        self._queue_processed = 0
        # Phase 0 daemon mode: heartbeat throttling state.
        self._daemon_mode = False
        self._last_heartbeat_ms = 0

    # -- helpers ----------------------------------------------------------
    def _now_ms(self) -> int:
        return int(self._clock() * 1000)

    def _utc_day(self) -> str:
        return datetime.fromtimestamp(self._clock(), tz=timezone.utc).strftime("%Y-%m-%d")

    def _log(self, event: str, **fields: Any) -> None:
        record = {"event": event, "at": self._now_ms(), **fields}
        self._logger.info(json.dumps(record, ensure_ascii=False, sort_keys=True))

    def _next_expected_ms(self, *, horizon_ms: int | None = None) -> int:
        """When the scheduler should expect the next heartbeat.

        Always relative to *now* (not startedAt): during a long backlog run the
        old ``startedAt + interval`` value went stale while the runner was still
        busy, which the page rendered as "disconnected" (F9).
        """
        interval_s = DAEMON_HEARTBEAT_SECONDS if self._daemon_mode else self.config.interval_seconds
        interval_ms = max(1, int(interval_s)) * 1000
        return self._now_ms() + max(interval_ms, int(horizon_ms or 0))

    def _long_task_horizon_ms(self) -> int:
        """Upper bound for one grounded task: text + scorecard + TTS/detector."""
        return int(
            max(
                float(self.config.interval_seconds),
                float(self.config.grounded_text_timeout) + 120.0,
            )
            * 1000
        )

    def _send_heartbeat(
        self,
        run_id: str,
        status: str,
        *,
        started_at: int,
        finished_at: int | None = None,
        detail: str | None = None,
        next_expected_at: int | None = None,
        throttle: bool = False,
    ) -> None:
        # Daemon idle cycles would otherwise send two heartbeats every few
        # seconds; throttled heartbeats go out at most once per minute.
        if (
            throttle
            and self._daemon_mode
            and self._now_ms() - self._last_heartbeat_ms < DAEMON_HEARTBEAT_SECONDS * 1000
        ):
            return
        payload = heartbeat_payload(
            automation_id=self.config.automation_id,
            generation=self.config.generation,
            client_run_id=run_id,
            status=status,
            started_at=started_at,
            finished_at=finished_at,
            next_expected_at=(
                next_expected_at
                if next_expected_at is not None
                else self._next_expected_ms()
            ),
            detail=detail[:500] if detail else detail,
        )
        try:
            self.client.call_tool(
                "report_scheduler_heartbeat", payload, client_run_id=run_id
            )
            self._last_heartbeat_ms = self._now_ms()
        except AuthError:
            raise
        except Exception as exc:  # heartbeat is observability, not the work
            self._log("heartbeat_failed", runId=run_id, code=_error_code(exc))

    def _send_progress_heartbeat(
        self,
        run_id: str,
        started_at: int,
        *,
        processed: int,
        detail: str,
        horizon_ms: int | None = None,
    ) -> None:
        """Re-announce "started" with a fresh nextExpectedAt while still busy.

        The server contract only allows started|finished|failed, so progress
        uses ``started`` (same startedAt) with a ``running`` detail and a
        nextExpectedAt measured from now. This does not add an MCP tool.
        """
        with contextlib.suppress(Exception):
            self._send_heartbeat(
                run_id,
                "started",
                started_at=started_at,
                detail=detail,
                next_expected_at=self._next_expected_ms(horizon_ms=horizon_ms),
            )

    def _reserve(self, kind: str) -> bool:
        costs = {
            "text": self.config.text_cost_cny,
            "audio": self.config.audio_cost_cny,
            "grounded": self.config.grounded_cost_cny,
        }
        cost = costs.get(kind, self.config.text_cost_cny)
        reserved = self.state.reserve_cost(cost, self.config.daily_cap_cny)
        cost_state = self.state.data["cost"]
        self._log(
            "cost_reserved" if reserved else "cost_cap_paused",
            kind=kind,
            costCny=cost,
            spentCny=cost_state.get("spentCny", 0.0),
            capCny=self.config.daily_cap_cny,
        )
        return reserved

    @staticmethod
    def _snapshot(attempt: Mapping[str, Any], day: int) -> dict[str, Any]:
        keys = (
            "id",
            "day",
            "stage",
            "title",
            "kind",
            "response",
            "conditions",
            "evidence",
            "recordingId",
            "context",
            "localOnly",
        )
        snapshot = {key: attempt[key] for key in keys if key in attempt}
        snapshot["day"] = day
        return snapshot

    @staticmethod
    def _has_usable_audio(attempt: Mapping[str, Any]) -> bool:
        if attempt.get("stage") != "speak":
            return False
        if not attempt.get("recordingId"):
            return False
        if attempt.get("localOnly"):
            return False
        conditions = str(attempt.get("conditions") or "")
        return "仅在原浏览器" not in conditions

    @staticmethod
    def _is_permanent(exc: BaseException) -> bool:
        if isinstance(exc, AuthError):
            return True
        if isinstance(exc, AudioError):
            return exc.code in PERMANENT_AUDIO_CODES or not exc.retryable
        if isinstance(exc, ContentRuleError):
            return not exc.retryable
        if isinstance(exc, ModelError):
            return not exc.retryable
        if isinstance(exc, ToolError):
            if exc.code in RETRYABLE_TOOL_CODES:
                return False
            # Transient write conflicts (the learner submitted again between
            # our session read and the writeback) are self-healing on the next
            # run, which re-reads the session. Blocking them would strand a
            # perfectly reviewable attempt, as happened on 2026-11-20.
            if any(fragment in str(exc) for fragment in TRANSIENT_TOOL_MESSAGES):
                return False
            return not exc.retryable
        if isinstance(exc, TransportError):
            return False
        if isinstance(exc, McpError):
            return True
        return False

    # -- recording --------------------------------------------------------
    def _read_recording(
        self, attempt: Mapping[str, Any], day: int, run_id: str
    ) -> bytes:
        recording_id = str(attempt["recordingId"])
        offset = 0
        chunks: list[bytes] = []
        total: int | None = None
        server_sha: str | None = None
        while True:
            response = self.client.call_tool(
                "read_speaking_recording",
                {
                    "day": day,
                    "recordingId": recording_id,
                    "mode": "bytes",
                    "offset": offset,
                    "length": self.config.chunk_bytes,
                },
                client_run_id=run_id,
            )
            if not isinstance(response, Mapping):
                raise McpError("read_speaking_recording returned an unexpected payload")
            size = int(response.get("size") or 0)
            if total is None:
                total = size
                server_sha = response.get("sha256") or response.get("digest")
            elif size != total:
                raise AudioError(
                    "recording_size_mismatch",
                    "recording size changed while it was being read",
                )
            if total > self.config.max_recording_bytes:
                raise AudioError(
                    "recording_too_large",
                    f"recording is {total} bytes, above the upload limit",
                )
            encoded = response.get("base64")
            if not isinstance(encoded, str):
                raise McpError("read_speaking_recording returned no base64")
            try:
                chunk = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise TransportError("invalid base64 in recording byte range") from exc
            reported_length = response.get("length")
            if reported_length is not None and len(chunk) != int(reported_length):
                raise TransportError("recording byte range was truncated")
            chunks.append(chunk)
            next_offset = response.get("nextOffset")
            if next_offset is None:
                break
            if not isinstance(next_offset, int) or next_offset <= offset:
                raise TransportError("recording byte range did not advance")
            offset = next_offset
            if len(chunks) > 1_000_000:
                raise AudioError("recording_too_large", "recording has too many ranges")
        expected_sha = attempt.get("recordingSha256") or server_sha
        return audio_module.reassemble(
            chunks, expected_size=total, expected_sha256=expected_sha
        )

    # -- review paths -----------------------------------------------------
    def _save_feedback(self, arguments: Mapping[str, Any], run_id: str) -> None:
        result = self.client.call_tool(
            "add_coach_feedback", dict(arguments), client_run_id=run_id
        )
        if isinstance(result, Mapping) and result.get("saved") is True:
            self._log(
                "feedback_saved",
                attempt=arguments.get("attempt"),
                duplicate=bool(result.get("duplicate")),
                receiptId=result.get("receiptId"),
                promptVersion=self.config.prompt_version,
            )
            return
        raise McpError("add_coach_feedback did not confirm the save")

    def _produce_text(self, attempt: Mapping[str, Any], day: int) -> Produced:
        """Pure text production: model call + content-rule validation, no save.

        Budget reservation and persistence are the caller's job so the owner and
        queue paths can share this exact logic with their own save contracts.
        """
        snapshot = self._snapshot(attempt, day)
        produced: Feedback = self.model.complete_text(snapshot)
        stage = str(attempt.get("stage"))
        validated = validate_feedback(
            produced.feedback,
            produced.evidence,
            produced.attempt,
            expected_attempt=str(attempt["id"]),
            stage=stage,
            recording_id=None,
            pronunciation=produced.pronunciation,
            audio_used=False,
            response=str(attempt.get("response") or ""),
        )
        return Produced(validated=validated, day=day, stage=stage)

    def _review_text(
        self, attempt: Mapping[str, Any], day: int, run_id: str
    ) -> str:
        if not self._reserve("text"):
            return "paused"
        produced = self._produce_text(attempt, day)
        self._save_feedback(produced.owner_args(), run_id)
        return "processed"

    def _review_audio(
        self, attempt: Mapping[str, Any], day: int, run_id: str
    ) -> str:
        recording_id = str(attempt["recordingId"])
        raw = self._read_recording(attempt, day, run_id)
        self._log(
            "recording_reassembled",
            attempt=str(attempt["id"]),
            bytes=len(raw),
            sha256=audio_module.sha256_bytes(raw),
        )
        if not self._reserve("audio"):
            return "paused"
        snapshot = self._snapshot(attempt, day)
        with tempfile.TemporaryDirectory(prefix="bandroom-audio-") as directory:
            prepared = self.prepare_audio(
                raw,
                workdir=Path(directory),
                bitrates_kbps=self.config.transcode_bitrates_kbps,
            )
            produced: Feedback = self.model.complete_audio(snapshot, prepared)
        validated = validate_feedback(
            produced.feedback,
            produced.evidence,
            produced.attempt,
            expected_attempt=str(attempt["id"]),
            stage="speak",
            recording_id=recording_id,
            pronunciation=produced.pronunciation,
            audio_used=True,
            response=str(attempt.get("response") or ""),
        )
        if validated.pronunciation is None:
            # The production speaking contract always writes recordingId plus a
            # provisional, whole-clip pronunciation observation.
            raise ContentRuleError(
                "pronunciation_missing",
                "an audio review must include a structured pronunciation rating",
                retryable=True,
            )
        arguments = feedback_to_tool_args(
            validated, day=day, stage="speak", recording_id=recording_id, audio_used=True
        )
        self._save_feedback(arguments, run_id)
        return "processed"

    def _tenant_entitlements(self, user_id: str, task: Mapping[str, Any]) -> tuple[bool, bool]:
        """MT-5 (G4 / license gate): (allow_detector, allow_tts) for a task tenant.

        The claim response may carry an ``entitlements`` map (source of truth =
        Worker user_entitlements table). Absent that, fail closed: only the
        deployment owner (config owner_user_id) is entitled by the single-owner
        personal-use posture; every other tenant gets detector/TTS OFF until an
        explicit grant + license② re-evaluation. This keeps NC-licensed weights
        from running for unentitled tenants by default.
        """
        ent = task.get("entitlements")
        if isinstance(ent, Mapping):
            return (bool(ent.get("detector_self_listen", False)), bool(ent.get("contrast_tts", False)))
        is_owner = bool(self.config.owner_user_id) and user_id == self.config.owner_user_id
        return (is_owner, is_owner)

    def _produce_grounded(
        self,
        attempt: Mapping[str, Any],
        day: int,
        raw: bytes,
        *,
        tenant_user_id: str | None = None,
        reserve_scorecard: Callable[[], bool] | None = None,
        reserve_tts: Callable[[int], bool] | None = None,
        refund_tts: Callable[[int], object] | None = None,
        allow_detector: bool = True,
        allow_tts: bool = True,
    ) -> Produced:
        """Pure grounded production over already-read recording bytes.

        Stage A/B calibrated prosody coach, no phoneme assertions. The dominant
        cost is the text-model call; the caller reserves the grounded budget
        bucket before inference. The scorecard is a SECOND text call and TTS
        contrast audio is billed per synthesis, so both get their own reserves
        via the optional callbacks (the owner path keeps its state-ledger
        reservation and does not track TTS). Stage B (detector candidates) is
        optional and fail-closed inside ``grounded_audio``. ``tenant_user_id``
        binds the per-user pause calibration to the claimed task's tenant (queue
        path); the owner path leaves it None (session-derived).
        """
        recording_id = str(attempt["recordingId"])
        started = time.time()
        # MT-5 (G4): the NC detector / commercial TTS run only for entitled
        # tenants. Override the grounded flags for this task without mutating the
        # shared config (the owner path passes allow_*=True and is unchanged).
        task_config = self.config
        if not allow_detector or not allow_tts:
            task_config = replace(
                self.config,
                grounded=replace(
                    self.config.grounded,
                    self_listen_enabled=self.config.grounded.self_listen_enabled and allow_detector,
                    contrast_audio_enabled=self.config.grounded.contrast_audio_enabled and allow_tts,
                ),
            )
        with tempfile.TemporaryDirectory(prefix="bandroom-grounded-") as directory:
            produced = grounded_audio.review_speaking_grounded(
                raw,
                attempt,
                day,
                config=task_config,
                model=self.model,
                workdir=Path(directory),
                logger=self._logger,
                reserve_scorecard=(
                    reserve_scorecard
                    if reserve_scorecard is not None
                    else (lambda: self._reserve("text"))
                ),
                reserve_tts=reserve_tts,
                refund_tts=refund_tts,
                tenant_user_id=tenant_user_id,
            )
        self._log(
            "grounded_model_usage",
            attempt=str(attempt["id"]),
            model=self.config.text_model,
            usage=getattr(self.model, "last_usage", None),
            costCny=self.config.grounded_cost_cny,
            latencySeconds=round(time.time() - started, 3),
        )
        validated = validate_feedback(
            produced.feedback,
            produced.evidence,
            produced.attempt,
            expected_attempt=str(attempt["id"]),
            stage="speak",
            recording_id=recording_id,
            pronunciation=produced.pronunciation,
            audio_used=True,
            response=str(attempt.get("response") or ""),
            analysis=getattr(produced, "analysis", None),
        )
        # The grounded path intentionally emits no pronunciation rating: the MCP
        # schema marks it optional and prescribes absence for technical decoding,
        # and lib/coach.ts would render any numeric band to the learner as
        # "发音专项暂定 X/9".  Only the legacy listening path requires it.
        return Produced(
            validated=validated,
            day=day,
            stage="speak",
            recording_id=recording_id,
            recording_sha256=audio_module.sha256_bytes(raw),
            audio_used=True,
            queue_analysis=getattr(produced, "queue_analysis", None),
        )

    def _review_audio_grounded(
        self, attempt: Mapping[str, Any], day: int, run_id: str
    ) -> str:
        raw = self._read_recording(attempt, day, run_id)
        self._log(
            "recording_reassembled",
            attempt=str(attempt["id"]),
            bytes=len(raw),
            sha256=audio_module.sha256_bytes(raw),
        )
        if not self._reserve("grounded"):
            return "paused"
        produced = self._produce_grounded(attempt, day, raw)
        self._save_feedback(produced.owner_args(), run_id)
        return "processed"

    def _process_attempt(
        self, attempt: Mapping[str, Any], session_day: int, run_id: str, report: RunReport
    ) -> str:
        attempt_id = str(attempt["id"])
        if self.state.is_blocked(attempt_id):
            report.skipped_blocked += 1
            self._log("attempt_blocked", attempt=attempt_id)
            return "skipped"
        day = int(attempt.get("day") or session_day or 1)
        try:
            if self._has_usable_audio(attempt):
                mode = resolve_coach_audio_mode(self.config)
                if mode == "grounded":
                    outcome = self._review_audio_grounded(attempt, day, run_id)
                elif mode == "legacy":
                    outcome = self._review_audio(attempt, day, run_id)
                else:
                    # "off" is filtered before dispatch; keep a text-safe fallback
                    # if a direct caller bypasses that filter.
                    outcome = self._review_text(attempt, day, run_id)
            else:
                outcome = self._review_text(attempt, day, run_id)
            if outcome == "paused":
                return "paused"
            self.state.mark_success(attempt_id)
            report.processed += 1
            self._log("attempt_processed", attempt=attempt_id, stage=attempt.get("stage"))
            return "processed"
        except AuthError:
            raise
        except Exception as exc:
            code = _error_code(exc)
            permanent = self._is_permanent(exc)
            blocked = self.state.note_failure(
                attempt_id,
                code,
                retryable=not permanent,
                max_attempts=self.config.max_attempts,
            )
            report.failed += 1
            detail = redact_error_detail(str(exc))
            report.errors.append(
                {"attempt": attempt_id, "code": code, "blocked": blocked, "detail": detail}
            )
            self._log(
                "attempt_failed",
                attempt=attempt_id,
                code=code,
                retryable=not permanent,
                blocked=blocked,
                # Without the message a failed writeback is undiagnosable; the
                # 2026-11-19 toolerror had to be reproduced by hand.
                detail=detail,
            )
            return "failed"

    # -- multi-tenant queue path (P2b) ------------------------------------
    def _read_task_recording(self, task: Mapping[str, Any], run_id: str) -> bytes:
        """Read a claimed speaking task's recording via the task/fence-bound tool.

        Unlike the owner path's ``read_speaking_recording`` (session-user keyed),
        ``read_review_recording`` is bound to the claimed task's exact fence and
        the server derives the tenant from the task row. Response uses ``total``
        (not ``size``) and a null ``nextOffset`` terminator.
        """
        task_id = str(task["id"])
        fence = int(task["fence"])
        lease = task.get("_lease")
        snapshot = task.get("snapshot") or {}
        frozen_sha = (snapshot.get("recording") or {}).get("sha256")
        offset = 0
        chunks: list[bytes] = []
        total: int | None = None
        server_sha: str | None = None
        while True:
            arguments = {
                "taskId": task_id,
                "fence": fence,
                "offset": offset,
                "length": self.config.chunk_bytes,
            }
            if lease is not None:
                arguments["lease"] = lease
            response = self.client.call_tool(
                "read_review_recording", arguments, client_run_id=run_id
            )
            if not isinstance(response, Mapping):
                raise McpError("read_review_recording returned an unexpected payload")
            size = int(response.get("total") or 0)
            if total is None:
                total = size
                server_sha = response.get("sha256")
            elif size != total:
                raise AudioError(
                    "recording_size_mismatch",
                    "recording size changed while it was being read",
                )
            if total > self.config.max_recording_bytes:
                raise AudioError(
                    "recording_too_large",
                    f"recording is {total} bytes, above the upload limit",
                )
            encoded = response.get("base64")
            if not isinstance(encoded, str):
                raise McpError("read_review_recording returned no base64")
            try:
                chunk = base64.b64decode(encoded, validate=True)
            except (binascii.Error, ValueError) as exc:
                raise TransportError("invalid base64 in recording byte range") from exc
            reported_length = response.get("length")
            if reported_length is not None and len(chunk) != int(reported_length):
                raise TransportError("recording byte range was truncated")
            chunks.append(chunk)
            next_offset = response.get("nextOffset")
            if next_offset is None:
                break
            if not isinstance(next_offset, int) or next_offset <= offset:
                raise TransportError("recording byte range did not advance")
            offset = next_offset
            if len(chunks) > 1_000_000:
                raise AudioError("recording_too_large", "recording has too many ranges")
        expected_sha = frozen_sha or server_sha
        return audio_module.reassemble(
            chunks, expected_size=total, expected_sha256=expected_sha
        )

    def _fairness_should_yield(self, user_id: str, other_tenants_due: bool = True) -> bool:
        # F5 fix: only yield when another tenant actually has due tasks.
        # Yielding when this is the only active tenant strands its backlog
        # (each yield burns an attempt via re-claim; after MAX_ATTEMPTS the
        # task is stuck). With markExhaustedGlobal it becomes needs_attention
        # instead of invisible, but it still never gets processed.
        if not other_tenants_due:
            return False
        return (
            user_id == self._fair_last_user
            and self._fair_run_length >= self.config.tenant_batch_cap
        )

    def _fairness_note_processed(self, user_id: str) -> None:
        if user_id == self._fair_last_user:
            self._fair_run_length += 1
        else:
            self._fair_last_user = user_id
            self._fair_run_length = 1

    def _process_queue_task(self, task: Mapping[str, Any]) -> bool:
        """Produce + complete one claimed cross-tenant task. True on success.

        The tenant comes from the claimed task row (server-derived), never from
        client input. Budget is reserved per user; a raised exception is
        classified by ``run_one`` (retryable fail, or NON-retryable for the
        disclosed speaking release-gate gap via ``PermanentTaskError``).
        """
        run_id = self._queue_run_id
        budget = self._tenant_budget
        if budget is None:
            raise McpError("tenant budget is not initialised; call run_multi_tenant")
        snapshot = task.get("snapshot")
        if not isinstance(snapshot, Mapping) or not isinstance(
            snapshot.get("attempt"), Mapping
        ):
            raise PermanentTaskError("snapshot_invalid", "claimed task has no attempt snapshot")
        attempt = snapshot["attempt"]
        # The frozen review is {sourceId, attempt, context} (app/api/state/route.ts):
        # context is a SIBLING of attempt, while the owner path inlines it into
        # each attempt (lib/coach.ts). Fold it in so both paths hand the model
        # the same payload; dropping it left the coach reviewing a reading
        # answer without the passage, choices or key. Inline context wins.
        frozen_context = snapshot.get("context")
        if isinstance(frozen_context, Mapping) and "context" not in attempt:
            attempt = {**attempt, "context": frozen_context}
        user_id = str(task["userId"])
        task_id = str(task["id"])
        fence = int(task["fence"])
        lease = task.get("_lease")
        day = int(task.get("day") or attempt.get("day") or 1)
        kind = str(task.get("kind") or "")

        if self._fairness_should_yield(user_id, bool(task.get("_otherTenantsDue", True))):
            raise TaskYielded("per_user_batch_cap")

        # F9: a grounded task can run 240-900 s. Announce that we are BUSY with
        # a long horizon before the model call so nextExpectedAt never goes
        # stale mid-task (the old startedAt+interval value did).
        self._send_progress_heartbeat(
            run_id,
            self._queue_started_at,
            processed=self._queue_processed,
            detail=f"running task={task_id}",
            horizon_ms=self._long_task_horizon_ms(),
        )

        if kind == "speaking":
            cost = self.config.grounded_cost_cny
            if not budget.reserve(user_id, cost, task_id=task_id):
                return False
            raw = self._read_task_recording(task, run_id)
            self._log(
                "recording_reassembled",
                attempt=str(attempt.get("id")),
                bytes=len(raw),
                sha256=audio_module.sha256_bytes(raw),
            )
            # F3: the grounded path also makes a separate scorecard text call
            # and up to self_listen_max_n*2 TTS calls. Reserve each bucket under
            # the SAME task id so a retryable failure refunds the whole attempt.
            tts_micro_per_call = int(round(self.config.tts_cost_cny * MICRO))
            allow_detector, allow_tts = self._tenant_entitlements(user_id, task)
            produced = self._produce_grounded(
                attempt,
                day,
                raw,
                tenant_user_id=user_id,
                allow_detector=allow_detector,
                allow_tts=allow_tts,
                reserve_scorecard=lambda: budget.reserve(
                    user_id, self.config.text_cost_cny, task_id=task_id
                ),
                reserve_tts=lambda count: budget.reserve_micro(
                    user_id, tts_micro_per_call * int(count), task_id=task_id
                ),
                refund_tts=lambda count: budget.refund_reserved(
                    user_id, tts_micro_per_call * int(count), task_id=task_id
                ),
            )
            # A2 integrity: recordingSha256 <-> R2 digest <-> snapshot is enforced
            # server-side; no decoded-PCM checkpoint (the transfer endpoint is
            # blocked on .workers.dev by isCanonicalOrigin — controlled-verification
            # finding). Keep review_transfer for a future custom-domain/A1 path.
            grounded_version = self.config.grounded_analysis_version
            if produced.queue_analysis is not None:
                grounded_version = str(
                    produced.queue_analysis.get("analysisVersion") or grounded_version
                )
            arguments = produced.complete_args(
                task_id, fence, analysis_version=grounded_version
            )
        else:
            cost = self.config.text_cost_cny
            if not budget.reserve(user_id, cost, task_id=task_id):
                return False
            produced = self._produce_text(attempt, day)
            arguments = produced.complete_args(
                task_id, fence, analysis_version=task.get("analysisVersion")
            )

        # B1: the lease is the authority for tenant/task/fence server-side.
        if lease is not None:
            arguments["lease"] = lease

        try:
            result = self.client.call_tool(
                "complete_review_task", arguments, client_run_id=run_id
            )
        except ToolError as exc:
            if exc.code in QUEUE_PERMANENT_CODES:
                # Fail-closed: the speaking completion contract is not released;
                # block once rather than burn claim attempts (owner decision A).
                raise PermanentTaskError(exc.code or "complete_rejected", str(exc)) from exc
            raise
        except AudioError as exc:
            if exc.code in QUEUE_PERMANENT_CODES or not exc.retryable:
                raise PermanentTaskError(exc.code, str(exc)) from exc
            raise
        if not isinstance(result, Mapping) or not result.get("receiptId"):
            raise McpError("complete_review_task did not return a receipt")
        self._fairness_note_processed(user_id)
        self._log(
            "queue_task_completed",
            task=task_id,
            userId=user_id,
            kind=kind,
            receiptId=result.get("receiptId"),
            duplicate=bool(result.get("duplicate")),
        )
        return True

    def run_multi_tenant(self) -> RunReport:
        """Cross-tenant queue loop: claim -> process -> complete until empty.

        Does NOT read the owner study session, mark local attempt state, or use
        add_coach_feedback — the server task row is the source of truth. Per-user
        budget caps skip only that tenant; the global cap pauses the whole run.
        """
        run_id = str(uuid.uuid4())
        self._queue_run_id = run_id
        report = RunReport(run_id=run_id)
        started_at = self._now_ms()
        self._queue_started_at = started_at
        self._queue_processed = 0
        budget = UserBudget(
            self.config.resolved_state_dir() / "tenant_budget.json",
            self.config.tenant_per_user_cap_cny,
            self.config.tenant_global_cap_cny,
        )
        self._tenant_budget = budget
        self._fair_last_user: str | None = None
        self._fair_run_length = 0
        self._log(
            "run_started",
            runId=run_id,
            mode="multi_tenant",
            perUserCapCny=self.config.tenant_per_user_cap_cny,
            globalCapCny=self.config.tenant_global_cap_cny,
            batchCap=self.config.tenant_batch_cap,
        )
        try:
            if not self._daemon_mode:
                self._send_heartbeat(run_id, "started", started_at=started_at)
            # Safety bound: a misbehaving queue must not spin forever in one run.
            for _ in range(1000):
                if budget.global_paused():
                    report.paused = True
                    report.detail = "tenant_global_cap_paused"
                    break
                outcome = run_one(
                    self.client,
                    self._process_queue_task,
                    budget,
                    client_run_id=self.config.tenant_client_run_id,
                    logger=self._logger,
                    fatal_errors=(AuthError,),
                )
                if outcome == "empty":
                    break
                if outcome == "processed":
                    report.processed += 1
                    self._queue_processed = report.processed
                    # F9: refresh nextExpectedAt after each task so a large
                    # backlog never looks like a missing runner.
                    self._send_progress_heartbeat(
                        run_id,
                        started_at,
                        processed=report.processed,
                        detail=f"running processed={report.processed}",
                    )
                elif outcome == "capped":
                    report.capped += 1
                elif outcome == "yielded":
                    report.yielded += 1
                elif outcome == "blocked":
                    report.blocked += 1
                else:
                    report.failed += 1
        except AuthError:
            report.fatal = True
            report.detail = "auth_failed"
            self._log("run_failed", runId=run_id, code="auth_failed")
        except Exception as exc:
            report.fatal = True
            report.detail = _error_code(exc)
            self._log("run_failed", runId=run_id, code=report.detail)
        finally:
            if report.paused:
                detail = report.detail or "tenant_global_cap_paused"
            elif report.fatal:
                detail = report.detail or "run_failed"
            else:
                detail = (
                    f"processed={report.processed} failed={report.failed} "
                    f"capped={report.capped} yielded={report.yielded} "
                    f"blocked={report.blocked}"
                )
            report.detail = detail
            status = "failed" if report.fatal else "finished"
            idle = not (
                report.fatal or report.paused or report.processed or report.failed
                or report.capped or report.yielded or report.blocked
            )
            with contextlib.suppress(Exception):
                self._send_heartbeat(
                    run_id,
                    status,
                    started_at=started_at,
                    finished_at=self._now_ms(),
                    detail=detail,
                    throttle=idle,
                )
            self.state.set_last_run(
                {
                    "runId": run_id,
                    "at": self._now_ms(),
                    "mode": "multi_tenant",
                    "processed": report.processed,
                    "failed": report.failed,
                    "capped": report.capped,
                    "yielded": report.yielded,
                    "blocked": report.blocked,
                    "paused": report.paused,
                    "fatal": report.fatal,
                    "detail": detail,
                }
            )
        return report

    def run_daemon(
        self,
        *,
        max_runtime_seconds: float = DAEMON_MAX_RUNTIME_SECONDS,
        max_tasks: int = DAEMON_MAX_TASKS,
        sleep: Callable[[float], None] = time.sleep,
        should_stop: Callable[[], bool] = lambda: False,
    ) -> DaemonReport:
        """Always-on loop: run a pass, then wait briefly and run again.

        Single instance is still guaranteed by the caller's flock (held for the
        whole process lifetime). Each pass re-reads the per-tenant budget file,
        and the owner cost state is rolled to the current UTC day every cycle.
        """
        self._daemon_mode = True
        report = DaemonReport()
        started = self._clock()
        idle_cycles = 0

        def wait(seconds: float) -> None:
            # Sleep in short slices so a stop signal is honoured promptly.
            deadline = self._clock() + seconds
            while not should_stop():
                remaining = deadline - self._clock()
                if remaining <= 0:
                    return
                sleep(min(1.0, remaining))

        self._log("daemon_started", maxRuntimeSeconds=max_runtime_seconds, maxTasks=max_tasks)
        while True:
            if should_stop():
                report.exit_reason = "signal"
                break
            self.state.ensure_day(self._utc_day())
            cycle = self.run()
            report.cycles += 1
            report.processed += cycle.processed
            report.failed += cycle.failed
            if cycle.fatal and cycle.detail == "auth_failed":
                # Do not hammer the site with bad credentials; the supervisor
                # restarts us after this back-off.
                report.fatal = True
                report.exit_reason = "auth_failed"
                wait(DAEMON_AUTH_FAILURE_SLEEP_SECONDS)
                break
            if report.processed >= max_tasks:
                report.exit_reason = "max_tasks"
                break
            if self._clock() - started >= max_runtime_seconds:
                report.exit_reason = "max_runtime"
                break
            did_work = bool(
                cycle.processed or cycle.failed or cycle.capped or cycle.yielded or cycle.blocked
            )
            if did_work:
                idle_cycles = 0
                delay = DAEMON_IDLE_BACKOFF_SECONDS[0]
            else:
                delay = daemon_idle_delay(idle_cycles)
                idle_cycles += 1
            if cycle.paused:
                delay = DAEMON_PAUSED_SLEEP_SECONDS
            elif cycle.fatal:
                delay = max(delay, DAEMON_ERROR_SLEEP_SECONDS)
            wait(delay)
        self._log("daemon_stopped", **report.to_dict())
        return report

    # -- run --------------------------------------------------------------
    def run(self) -> RunReport:
        if self.config.multi_tenant:
            return self.run_multi_tenant()
        run_id = str(uuid.uuid4())
        report = RunReport(run_id=run_id)
        started_at = self._now_ms()
        self.state.ensure_day(self._utc_day())

        if self.state.paused():
            report.paused = True
            report.detail = "cost_cap_paused"
            self._send_heartbeat(run_id, "finished", started_at=started_at, detail=report.detail)
            return report

        try:
            self._send_heartbeat(run_id, "started", started_at=started_at)
            session = self.client.call_tool("read_study_session", {}, client_run_id=run_id)
            if not isinstance(session, Mapping):
                raise McpError("read_study_session returned an unexpected payload")
            session_day = int(session.get("day") or 0)
            all_pending = [
                attempt
                for attempt in session.get("reviewAttempts") or []
                if isinstance(attempt, Mapping)
                and attempt.get("status") == "awaiting_coach"
                and attempt.get("kind") == "subjective"
                and attempt.get("id")
            ]
            # Audio dispatch (see resolve_coach_audio_mode).  "off" preserves the held
            # Gate-1 behaviour exactly: speaking attempts are skipped; text still
            # runs.  "legacy" preserves the old omni _review_audio path.
            # "grounded" sends speaking attempts through the calibrated path.
            mode = resolve_coach_audio_mode(self.config)
            if mode == "off":
                attempts = [
                    a for a in all_pending if a.get("stage") != "speak"
                ]
            else:
                attempts = all_pending
            skipped_audio = len(all_pending) - len(attempts)
            if skipped_audio:
                self._log("audio_held_skipped", runId=run_id, count=skipped_audio)
            self._log("run_started", runId=run_id, pending=len(attempts), audioMode=mode)
            for attempt in attempts:
                if self.state.paused():
                    report.paused = True
                    break
                outcome = self._process_attempt(attempt, session_day, run_id, report)
                if outcome == "paused":
                    report.paused = True
                    break
        except AuthError:
            report.fatal = True
            report.detail = "auth_failed"
            self._log("run_failed", runId=run_id, code="auth_failed")
        except Exception as exc:
            report.fatal = True
            report.detail = _error_code(exc)
            self._log("run_failed", runId=run_id, code=report.detail)
        finally:
            if report.paused:
                detail = "cost_cap_paused"
            elif report.fatal:
                detail = report.detail or "run_failed"
            else:
                detail = (
                    f"processed={report.processed} failed={report.failed} "
                    f"blocked={report.skipped_blocked}"
                )
            report.detail = detail
            status = "failed" if report.fatal else "finished"
            with contextlib.suppress(Exception):
                self._send_heartbeat(
                    run_id,
                    status,
                    started_at=started_at,
                    finished_at=self._now_ms(),
                    detail=detail,
                )
            self.state.set_last_run(
                {
                    "runId": run_id,
                    "at": self._now_ms(),
                    "processed": report.processed,
                    "failed": report.failed,
                    "paused": report.paused,
                    "fatal": report.fatal,
                    "detail": detail,
                    "costCny": self.state.data["cost"].get("spentCny", 0.0),
                }
            )
        return report


# -- dry-run mocks --------------------------------------------------------
class _DryRunClient:
    """In-memory stand-in; no sockets, no files."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def call_tool(self, name: str, arguments=None, *, client_run_id=None):
        arguments = dict(arguments or {})
        self.calls.append((name, arguments))
        if name == "read_study_session":
            return {
                "day": 1,
                "reviewAttempts": [
                    {
                        "id": "v2:dryrun-writing",
                        "day": 1,
                        "stage": "write",
                        "kind": "subjective",
                        "status": "awaiting_coach",
                        "title": "写作首稿",
                        "response": "I go to school yesterday.",
                        "conditions": "限时 20 分钟",
                        "context": {"prompt": "Describe your day."},
                    }
                ],
            }
        if name == "add_coach_feedback":
            return {"saved": True, "duplicate": False, "receiptId": "dry-run-receipt"}
        if name == "report_scheduler_heartbeat":
            return {"ok": True}
        return {}


class _DryRunModel:
    provider = "dry-run"

    def complete_text(self, snapshot):
        response = str(snapshot.get("response", ""))
        return Feedback(
            feedback="把“I go”改成“I went”，因为 yesterday 表示过去。下一步：用三个过去式句子描述昨天。",
            evidence=f"原文包含 “{response}”，时态需要改为一般过去时。",
            attempt=str(snapshot["id"]),
        )

    def complete_audio(self, snapshot, audio):  # pragma: no cover - dry run is text
        return Feedback(
            feedback="Dry-run audio review.",
            evidence=f"recording {snapshot.get('recordingId')}",
            attempt=str(snapshot["id"]),
            pronunciation=None,
        )


def build_dry_run_runner(state_dir: Path | None = None) -> CoachRunner:
    config = RunnerConfig(
        client_id="dry-run",
        client_secret="dry-run",
        api_key="dry-run",
        state_dir=state_dir or Path(tempfile.mkdtemp(prefix="bandroom-dry-run-")),
    )
    return CoachRunner(config, client=_DryRunClient(), model=_DryRunModel())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="runner.orchestrator",
        description=(
            "Bandroom own coach runner: review pending attempts with an "
            "audio-capable model and write feedback through add_coach_feedback."
        ),
    )
    parser.add_argument(
        "--config",
        default="runner/config.toml",
        help="TOML config path (secrets come from environment variables)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="run one pass with in-memory mocks; no network, model, or site calls",
    )
    parser.add_argument(
        "--once", action="store_true", help="run a single pass (default; kept for cron clarity)"
    )
    parser.add_argument(
        "--daemon",
        action="store_true",
        help="stay running: poll the queue every 2-10 s and exit after a bounded lifetime "
        "(run under launchd KeepAlive / systemd Restart=always)",
    )
    parser.add_argument(
        "--max-runtime-seconds", type=float, default=DAEMON_MAX_RUNTIME_SECONDS,
        help="daemon only: exit cleanly after this many seconds (default 6 h)",
    )
    parser.add_argument(
        "--max-tasks", type=int, default=DAEMON_MAX_TASKS,
        help="daemon only: exit cleanly after processing this many tasks (default 200)",
    )
    parser.add_argument(
        "--state-dir", default=None, help="override the persistent state directory"
    )
    parser.add_argument(
        "--clear-blocks",
        action="store_true",
        help="clear blocked attempts and the cost pause before running",
    )
    parser.add_argument(
        "--no-lock", action="store_true", help="skip the flock guard (tests only)"
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if args.dry_run:
        runner = build_dry_run_runner(Path(args.state_dir) if args.state_dir else None)
        report = runner.run()
        print(json.dumps({"dryRun": True, **report.to_dict()}, ensure_ascii=False))
        return 0

    try:
        config = load_config(args.config)
    except (OSError, ConfigError, tomllib.TOMLDecodeError) as exc:
        print(json.dumps({"error": "config_error", "detail": str(exc)}, ensure_ascii=False))
        return 2
    if args.state_dir:
        config = replace(config, state_dir=Path(args.state_dir))

    if args.clear_blocks:
        StateStore(config.resolved_state_dir() / "state.json").clear_blocks()

    lock_path = config.resolved_state_dir() / "runner.lock"
    try:
        context = (
            contextlib.nullcontext() if args.no_lock else single_instance_lock(lock_path)
        )
        with context:
            if args.daemon:
                stop = {"requested": False}

                def request_stop(signum, _frame):  # pragma: no cover - signal wiring
                    stop["requested"] = True

                # SIGHUP/SIGTERM/SIGINT: finish the current pass, then exit so
                # the supervisor restarts with reloaded config and credentials.
                for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
                    signal.signal(signum, request_stop)
                report = CoachRunner(config).run_daemon(
                    max_runtime_seconds=args.max_runtime_seconds,
                    max_tasks=args.max_tasks,
                    should_stop=lambda: stop["requested"],
                )
            else:
                report = CoachRunner(config).run()
    except AlreadyRunning:
        print(json.dumps({"error": "already_running"}, ensure_ascii=False))
        return 3
    print(json.dumps(report.to_dict(), ensure_ascii=False))
    return 0 if not report.fatal else 1


if __name__ == "__main__":
    raise SystemExit(main())