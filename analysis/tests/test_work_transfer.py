import argparse
import base64
from contextlib import contextmanager
from email.message import Message
from hashlib import sha256
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.request import Request

from bandroom_acoustic import work_transfer as transfer


def identity(data):
    return transfer.Identity(sha256(data).hexdigest(), len(data))


class Response(BytesIO):
    def __init__(self, data, status, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or Message()


class WorkTransferTests(unittest.TestCase):
    def setUp(self):
        folder = TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.original = b"original audio bytes"
        self.checkpoint = b"committed acoustic checkpoint"
        self.input = identity(self.original)
        self.artifact = identity(self.checkpoint)
        self.args = argparse.Namespace(
            origin="https://isolated.example", analysis_version="analysis-v1",
            chunk_index=2, timeout=1, file=self.root / "recording",
        )

    def envelope(self, method="GET", checkpoint=True):
        grant = {
            "url": f"{self.args.origin}/api/review-transfer",
            "method": method,
            "input": self.input.public(),
            "expiresAt": time.time_ns() // 1_000_000 + 60_000,
            "authorization": "Bearer test-only-grant",
        }
        if checkpoint:
            grant.update(artifact=self.artifact.public(), analysisVersion="analysis-v1", chunkIndex=2)
        return {"grant": grant, "sitesAuthorization": "Bearer test-only-site"}

    def ranges(self, qa=False):
        total_key = "totalBytes" if qa else "total"
        task = {"jobId": "job"} if qa else {"taskId": "task", "recordingId": "recording"}
        for offset in range(0, self.input.bytes, 7):
            block = self.original[offset:offset + 7]
            end = offset + len(block)
            yield {
                **task, "sha256": self.input.sha256, total_key: self.input.bytes,
                "offset": offset, "length": len(block),
                "nextOffset": end if end < self.input.bytes else None,
                "base64": base64.b64encode(block).decode(),
            }

    def assemble(self, rows, qa=False):
        stream = BytesIO(b"".join(json.dumps(row).encode() + b"\n" for row in rows))
        blocks = transfer.mcp_blocks(stream, self.input, "job" if qa else "task", None if qa else "recording")
        transfer.write_verified(self.args.file, self.input, blocks)

    def test_accepts_ordered_ranges_in_both_connector_schemas(self):
        for qa in (True, False):
            with self.subTest(qa=qa):
                self.assemble(self.ranges(qa), qa=qa)
                self.assertEqual(self.args.file.read_bytes(), self.original)
                self.assertEqual(list(self.root.iterdir()), [self.args.file])

    def test_interrupted_or_corrupt_ranges_do_not_replace_existing_output(self):
        self.args.file.write_bytes(b"existing")
        a, b, c = self.ranges()
        cases = [
            ([a, c, b], "recording_range_mismatch"),
            ([a, {**b, "recordingId": "other"}, c], "recording_range_mismatch"),
            ([a, b], "recording_range_truncated"),
            ([a, b, {**c, "base64": base64.b64encode(b"x" * c["length"]).decode()}],
             "transfer_integrity_failed"),
            ([a, b, c, c], "recording_range_trailing_data"),
        ]
        for rows, code in cases:
            with self.subTest(code=code), self.assertRaisesRegex(transfer.TransferError, code):
                self.assemble(rows)
            self.assertEqual(self.args.file.read_bytes(), b"existing")
            self.assertEqual(list(self.root.iterdir()), [self.args.file])

    def test_rejects_grant_for_other_artifact_origin_or_expired_lease(self):
        envelope = self.envelope()
        for field, value in (
            ("url", self.args.origin + "/api/review-transfer?unbound"),
            ("chunkIndex", 3),
            ("artifact", self.input.public()),
            ("expiresAt", 1),
        ):
            with self.subTest(field=field), self.assertRaises(transfer.TransferError):
                transfer.grant_request(
                    self.args, {**envelope, "grant": {**envelope["grant"], field: value}},
                    self.input, self.artifact, "GET",
                )
        self.args.origin = "https://[broken"
        with self.assertRaisesRegex(transfer.TransferError, "invalid_transfer_origin"):
            transfer.grant_request(self.args, envelope, self.input, self.artifact, "GET")

    def test_real_http_redirect_does_not_forward_private_headers(self):
        seen = []

        class Redirect(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path, self.headers.get("Authorization")))
                self.send_response(302 if self.path == "/original" else 200)
                self.send_header("Location", "/next")
                self.end_headers()

            def log_message(self, *_args):
                pass

        with ThreadingHTTPServer(("127.0.0.1", 0), Redirect) as server:
            worker = Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                url = f"http://127.0.0.1:{server.server_port}/original"
                request = Request(url, headers={"Authorization": "Bearer test-only-grant"})
                with self.assertRaisesRegex(transfer.TransferError, "transfer_redirect_rejected"):
                    with transfer.open_transfer(request, timeout=2):
                        self.fail("redirect followed")
            finally:
                server.shutdown()
                worker.join(timeout=2)
        self.assertEqual(seen, [("/original", "Bearer test-only-grant")])

    def test_download_requires_exact_length_headers_and_body(self):
        headers = Message()
        headers["Content-Length"] = str(self.artifact.bytes)
        headers["X-Bandroom-SHA256"] = self.artifact.sha256
        envelope = self.envelope()
        for body, code in (
            (self.checkpoint[:-1], "transfer_read_truncated"),
            (b"x" * self.artifact.bytes, "transfer_integrity_failed"),
            (self.checkpoint, None),
        ):
            @contextmanager
            def response(request, timeout):
                self.assertEqual(request.get_method(), "GET")
                self.assertEqual(request.get_header("Authorization"), "Bearer test-only-grant")
                self.assertEqual(request.get_header("Oai-sites-authorization"), "Bearer test-only-site")
                with Response(body, 200, headers) as reply:
                    yield reply

            with self.subTest(code=code), patch.object(transfer, "open_transfer", response):
                if code:
                    with self.assertRaisesRegex(transfer.TransferError, code):
                        transfer.download(self.args, envelope, self.input, self.artifact)
                    self.assertFalse(self.args.file.exists())
                else:
                    self.assertEqual(transfer.download(self.args, envelope, self.input, self.artifact),
                                     self.artifact.public())
                    self.assertEqual(self.args.file.read_bytes(), self.checkpoint)
        headers["Content-Length"] = str(self.artifact.bytes)
        with patch.object(transfer, "open_transfer", response):
            with self.assertRaisesRegex(transfer.TransferError, "transfer_response_mismatch"):
                transfer.download(self.args, envelope, self.input, self.artifact)

    def test_upload_checks_source_and_requires_receipt_with_committed_pointer(self):
        self.args.file.write_bytes(self.checkpoint)
        envelope = self.envelope("PUT")
        for status, result, code in (
            (201, {"saved": True, "duplicate": False, "checkpointSha256": self.artifact.sha256}, None),
            (200, {"saved": True, "duplicate": True, "checkpointSha256": self.input.sha256}, None),
            (201, {"saved": True, "duplicate": False, "checkpointSha256": self.input.sha256},
             "checkpoint_receipt_unconfirmed"),
            (201, {}, "checkpoint_receipt_unconfirmed"),
        ):
            @contextmanager
            def response(request, timeout):
                self.assertEqual(request.get_method(), "PUT")
                self.assertEqual(request.get_header("Content-length"), str(self.artifact.bytes))
                self.assertEqual(request.data.read(), self.checkpoint)
                with Response(json.dumps(result).encode(), status) as reply:
                    yield reply

            with self.subTest(status=status, code=code), patch.object(transfer, "open_transfer", response):
                if code:
                    with self.assertRaisesRegex(transfer.TransferError, code) as failed:
                        transfer.upload(self.args, envelope, self.input, self.artifact)
                    self.assertTrue(failed.exception.reconcile)
                else:
                    self.assertEqual(transfer.upload(self.args, envelope, self.input, self.artifact),
                                     {**self.artifact.public(), **result})
        self.args.file.write_bytes(self.checkpoint + b"x")
        with patch.object(transfer, "open_transfer") as transport:
            with self.assertRaisesRegex(transfer.TransferError, "local_checkpoint_mismatch"):
                transfer.upload(self.args, envelope, self.input, self.artifact)
            transport.assert_not_called()

    def test_transient_put_failure_requests_reconciliation_stale_fence_does_not(self):
        self.args.file.write_bytes(self.checkpoint)
        envelope = self.envelope("PUT")
        for error, code, retry in (
            (URLError("timed out"), "transfer_network_unavailable", True),
            (HTTPError(self.args.origin, 503, "Unavailable", {}, BytesIO(b'{"error":"transfer_storage_unavailable"}')),
             "transfer_storage_unavailable", True),
            (HTTPError(self.args.origin, 409, "Conflict", {}, BytesIO(b'{"error":"stale_lease"}')),
             "stale_lease", False),
        ):
            with self.subTest(code=code), patch.object(transfer, "build_opener") as opener:
                opener.return_value.open.side_effect = error
                with self.assertRaisesRegex(transfer.TransferError, code) as failed:
                    transfer.upload(self.args, envelope, self.input, self.artifact)
                self.assertIs(failed.exception.retryable, retry)
                self.assertIs(failed.exception.reconcile, retry)


if __name__ == "__main__":
    unittest.main()
