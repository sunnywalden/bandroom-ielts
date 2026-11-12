"""Move private Work recording and checkpoint bytes with verified identities."""

from __future__ import annotations

import argparse
import base64
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from hashlib import sha256
from http.client import HTTPException
import json
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile
import time
from typing import BinaryIO
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .decode import MAX_AUDIO


BLOCK = 64 * 1024
MAX_MCP_RANGE = 256 * 1024
MAX_CHECKPOINT = MAX_AUDIO + 4096 + 4
MAX_CONTROL_BYTES = 32 * 1024
BEARER = re.compile(r"Bearer [A-Za-z0-9._~+/=-]{1,8192}")
RETRYABLE_HTTP = {408, 425, 429, 500, 502, 503, 504}
SERVER_ERRORS = {
    "analysis_version_mismatch", "artifact_conflict", "checkpoint_advanced", "checkpoint_object_missing",
    "invalid_acoustic_checkpoint", "invalid_decode_checkpoint", "recording_changed",
    "recording_integrity_unavailable", "recording_missing", "recording_read_failed", "stale_lease",
    "task_not_found", "transfer_access_denied", "transfer_expired", "transfer_integrity_failed",
    "transfer_storage_unavailable",
}


class TransferError(ValueError):
    def __init__(self, code: str, *, retryable: bool = False, reconcile: bool = False):
        super().__init__(code)
        self.code = code
        self.retryable = retryable
        self.reconcile = reconcile


def is_digest(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


@dataclass(frozen=True)
class Identity:
    sha256: str
    bytes: int

    @classmethod
    def parse(cls, value: object, limit: int) -> Identity:
        if (not isinstance(value, dict) or set(value) != {"sha256", "bytes"} or not is_digest(value["sha256"])
                or type(value["bytes"]) is not int or not 0 < value["bytes"] <= limit):
            raise TransferError("invalid_transfer_identity")
        return cls(value["sha256"], value["bytes"])

    def public(self) -> dict:
        return {"sha256": self.sha256, "bytes": self.bytes}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def grant_request(args: argparse.Namespace, envelope: dict, original: Identity,
                  artifact: Identity | None, method: str, data: BinaryIO | None = None) -> Request:
    try:
        origin = urlsplit(args.origin)
        port = origin.port
    except ValueError:
        raise TransferError("invalid_transfer_origin") from None
    if (origin.scheme != "https" or not origin.hostname or origin.username is not None or port == 0
            or args.origin != f"https://{origin.netloc}" or "\\" in args.origin
            or any(ord(c) < 33 or ord(c) > 126 for c in args.origin)):
        raise TransferError("invalid_transfer_origin")
    grant = envelope.get("grant")
    url = f"{args.origin}/api/review-transfer"
    if not isinstance(grant, dict) or grant.get("url") != url or grant.get("method") != method:
        raise TransferError("transfer_grant_mismatch")
    if (Identity.parse(grant.get("input"), MAX_AUDIO) != original
            or grant.get("analysisVersion") != args.analysis_version or grant.get("chunkIndex") != args.chunk_index
            or (args.chunk_index is not None and type(grant.get("chunkIndex")) is not int)
            or (artifact is None and "artifact" in grant)
            or (artifact is not None and Identity.parse(grant.get("artifact"), MAX_CHECKPOINT) != artifact)):
        raise TransferError("transfer_grant_mismatch")
    expires = grant.get("expiresAt")
    if type(expires) is not int or expires <= time.time_ns() // 1_000_000:
        raise TransferError("transfer_grant_expired", retryable=True)
    bearer = grant.get("authorization")
    if not isinstance(bearer, str) or BEARER.fullmatch(bearer) is None:
        raise TransferError("invalid_transfer_authorization")
    headers = {"Authorization": bearer, "Accept-Encoding": "identity"}
    if "sitesAuthorization" in envelope:
        sites = envelope["sitesAuthorization"]
        if not isinstance(sites, str) or BEARER.fullmatch(sites) is None:
            raise TransferError("invalid_sites_authorization")
        headers["OAI-Sites-Authorization"] = sites
    if data is not None and artifact is not None:
        headers["Content-Type"] = "application/octet-stream"
        headers["Content-Length"] = str(artifact.bytes)
    return Request(url, data=data, headers=headers, method=method)


def read_object(stream: BinaryIO, limit: int) -> dict:
    value = stream.read(limit + 1)
    if len(value) > limit:
        raise TransferError("transfer_control_too_large")
    try:
        result = json.loads(value)
    except (UnicodeError, ValueError, RecursionError):
        raise TransferError("invalid_transfer_control") from None
    if not isinstance(result, dict):
        raise TransferError("invalid_transfer_control")
    return result


def response_error(error: HTTPError, upload: bool) -> TransferError:
    with error:
        if 300 <= error.code < 400:
            return TransferError("transfer_redirect_rejected", reconcile=upload)
        retryable = error.code in RETRYABLE_HTTP
        try:
            detail = read_object(error, MAX_CONTROL_BYTES).get("error")
        except (TransferError, OSError, HTTPException):
            detail = None
        if not isinstance(detail, str) or detail not in SERVER_ERRORS:
            detail = "transfer_http_unavailable" if retryable else "transfer_http_rejected"
        return TransferError(detail, retryable=retryable, reconcile=upload and retryable)


@contextmanager
def open_transfer(request: Request, timeout: float):
    upload = request.get_method() == "PUT"
    try:
        response = build_opener(NoRedirect()).open(request, timeout=timeout)
    except HTTPError as error:
        raise response_error(error, upload) from None
    except (URLError, OSError, HTTPException):
        raise TransferError("transfer_network_unavailable", retryable=True, reconcile=upload) from None
    with response:
        yield response


def http_blocks(response: BinaryIO, length: int, deadline: float) -> Iterator[bytes]:
    remaining = length
    while remaining:
        if time.monotonic() >= deadline:
            raise TransferError("transfer_read_timeout", retryable=True)
        try:
            data = response.read(min(BLOCK, remaining))
        except (OSError, HTTPException):
            raise TransferError("transfer_read_failed", retryable=True) from None
        if not data:
            raise TransferError("transfer_read_truncated", retryable=True)
        yield data
        remaining -= len(data)


def write_verified(path: Path, identity: Identity, blocks: Iterable[bytes]) -> None:
    digest = sha256()
    length = 0
    temporary = None
    try:
        with NamedTemporaryFile(dir=path.parent, delete=False) as target:
            temporary = Path(target.name)
            for block in blocks:
                length += len(block)
                if length > identity.bytes:
                    raise TransferError("transfer_length_mismatch")
                digest.update(block)
                target.write(block)
        if length != identity.bytes or digest.hexdigest() != identity.sha256:
            raise TransferError("transfer_integrity_failed")
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def download(args: argparse.Namespace, envelope: dict, original: Identity, artifact: Identity | None) -> dict:
    identity = artifact or original
    request = grant_request(args, envelope, original, artifact, "GET")
    deadline = time.monotonic() + args.timeout
    with open_transfer(request, args.timeout) as response:
        headers = response.headers
        if (response.status != 200 or headers.get_all("Content-Length") != [str(identity.bytes)]
                or headers.get_all("X-Bandroom-SHA256") != [identity.sha256]
                or headers.get_all("Content-Encoding") not in (None, ["identity"])):
            raise TransferError("transfer_response_mismatch")
        write_verified(args.file, identity, http_blocks(response, identity.bytes, deadline))
    return identity.public()


def upload(args: argparse.Namespace, envelope: dict, original: Identity, artifact: Identity) -> dict:
    with args.file.open("rb") as data:
        digest = sha256()
        remaining = artifact.bytes
        while remaining:
            block = data.read(min(BLOCK, remaining))
            if not block:
                raise TransferError("local_checkpoint_mismatch")
            digest.update(block)
            remaining -= len(block)
        if digest.hexdigest() != artifact.sha256 or data.read(1):
            raise TransferError("local_checkpoint_mismatch")
        data.seek(0)
        request = grant_request(args, envelope, original, artifact, "PUT", data)
        with open_transfer(request, args.timeout) as response:
            try:
                receipt = read_object(response, MAX_CONTROL_BYTES)
            except (TransferError, OSError, HTTPException):
                raise TransferError("checkpoint_receipt_unconfirmed", reconcile=True) from None
            duplicate = receipt.get("duplicate")
            pointer = receipt.get("checkpointSha256")
            if (receipt.get("saved") is not True or type(duplicate) is not bool
                    or response.status != (200 if duplicate else 201) or not is_digest(pointer)
                    or (not duplicate and pointer != artifact.sha256)):
                raise TransferError("checkpoint_receipt_unconfirmed", reconcile=True)
    return {**artifact.public(), "saved": True, "duplicate": duplicate, "checkpointSha256": pointer}


def mcp_blocks(stream: BinaryIO, original: Identity, task_id: str, recording_id: str | None) -> Iterator[bytes]:
    offset = 0
    id_key = "taskId" if recording_id is not None else "jobId"
    total_key = "total" if recording_id is not None else "totalBytes"
    max_line = (MAX_MCP_RANGE + 2) // 3 * 4 + 4096
    while offset < original.bytes:
        line = stream.readline(max_line + 1)
        if not line:
            raise TransferError("recording_range_truncated", retryable=True)
        if len(line) > max_line:
            raise TransferError("recording_range_too_large")
        try:
            row = json.loads(line)
        except (UnicodeError, ValueError, RecursionError):
            raise TransferError("invalid_recording_range") from None
        if (not isinstance(row, dict) or row.get(id_key) != task_id or row.get("sha256") != original.sha256
                or (recording_id is not None and row.get("recordingId") != recording_id)
                or type(row.get(total_key)) is not int or row[total_key] != original.bytes
                or type(row.get("offset")) is not int or row["offset"] != offset
                or type(row.get("length")) is not int or not 0 < row["length"] <= MAX_MCP_RANGE
                or not isinstance(row.get("base64"), str)):
            raise TransferError("recording_range_mismatch")
        next_offset = offset + row["length"]
        if (next_offset > original.bytes or "nextOffset" not in row
                or (next_offset < original.bytes and
                    (type(row["nextOffset"]) is not int or row["nextOffset"] != next_offset))
                or (next_offset == original.bytes and row["nextOffset"] is not None)):
            raise TransferError("recording_range_mismatch")
        try:
            block = base64.b64decode(row["base64"], validate=True)
        except ValueError:
            raise TransferError("invalid_recording_range") from None
        if len(block) != row["length"]:
            raise TransferError("recording_range_truncated", retryable=True)
        yield block
        offset = next_offset
    if stream.read(1):
        raise TransferError("recording_range_trailing_data")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("download", "upload", "assemble-recording"):
        command = commands.add_parser(name)
        command.add_argument("--file", type=Path, required=True)
        command.add_argument("--input-sha256", required=True)
        command.add_argument("--input-bytes", type=int, required=True)
        if name == "assemble-recording":
            identities = command.add_mutually_exclusive_group(required=True)
            identities.add_argument("--task-id")
            identities.add_argument("--qa-job-id")
            command.add_argument("--recording-id")
        else:
            command.add_argument("--origin", required=True)
            command.add_argument("--analysis-version")
            command.add_argument("--chunk-index", type=int)
            command.add_argument("--artifact-sha256")
            command.add_argument("--artifact-bytes", type=int)
            command.add_argument("--timeout", type=float, default=25)
    args = parser.parse_args()
    try:
        original = Identity.parse({"sha256": args.input_sha256, "bytes": args.input_bytes}, MAX_AUDIO)
        if args.command == "assemble-recording":
            if bool(args.task_id) != bool(args.recording_id):
                raise TransferError("invalid_recording_identity")
            blocks = mcp_blocks(sys.stdin.buffer, original, args.task_id or args.qa_job_id, args.recording_id)
            write_verified(args.file, original, blocks)
            result = original.public()
        else:
            checkpoint = args.artifact_sha256 is not None or args.artifact_bytes is not None
            if (checkpoint != bool(args.analysis_version) or (args.command == "upload" and not checkpoint)
                    or (args.chunk_index is not None and (not checkpoint or not 0 <= args.chunk_index <= 50))
                    or not 0 < args.timeout <= 120):
                raise TransferError("invalid_transfer_arguments")
            artifact = Identity.parse({"sha256": args.artifact_sha256, "bytes": args.artifact_bytes},
                                      MAX_CHECKPOINT) if checkpoint else None
            envelope = read_object(sys.stdin.buffer, MAX_CONTROL_BYTES)
            result = (upload(args, envelope, original, artifact) if args.command == "upload"
                      else download(args, envelope, original, artifact))
        print(json.dumps(result))
        return 0
    except TransferError as error:
        print(json.dumps({"error": error.code, "retryable": error.retryable, "reconcile": error.reconcile}),
              file=sys.stderr)
    except OSError:
        print(json.dumps({"error": "local_transfer_io_failed", "retryable": False, "reconcile": False}),
              file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
