from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from bandroom_acoustic.acoustic_stage import (
    AcousticStore, FRAME_SAMPLES, PASS_OFFSETS, RECEPTIVE_SAMPLES, encode_chunk, windows,
)


class AcousticWindowsTest(unittest.TestCase):
    def test_both_passes_cover_all_frames_of_180_second_recording(self):
        sample_count = 180 * 16_000
        frame_count = (sample_count - RECEPTIVE_SAMPLES) // FRAME_SAMPLES + 1
        plan = list(windows(sample_count))
        self.assertEqual(len(plan), 24)
        for offset in PASS_OFFSETS:
            current = 0
            for window in (window for window in plan if window.offset == offset):
                self.assertEqual(window.start_frame, current)
                self.assertLessEqual(window.left_context, window.start_frame)
                self.assertLessEqual(window.end_frame, window.right_context)
                self.assertLessEqual((window.right_context - 1) * FRAME_SAMPLES + RECEPTIVE_SAMPLES, sample_count)
                self.assertGreater(window.bytes, 0)
                current = window.end_frame
            self.assertEqual(current, frame_count)

    def test_minimum_input_is_one_complete_receptive_field_per_pass(self):
        self.assertEqual([(w.start_frame, w.end_frame) for w in windows(RECEPTIVE_SAMPLES)], [(0, 1), (0, 1)])
        with self.assertRaisesRegex(ValueError, "25 ms"):
            list(windows(RECEPTIVE_SAMPLES - 1))


class AcousticStoreTest(unittest.TestCase):
    def test_transport_restores_only_verified_chunks_in_order(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan = list(windows(16_000))
            identity = {"decodeSha256": "d" * 64, "bundleSha256": "b" * 64, "configSha256": "c" * 64}
            rows = [bytes([index]) * window.bytes for index, window in enumerate(plan)]
            first = AcousticStore(root / "first", identity, plan)
            exported = root / "export"
            digests = first.export(exported, rows)
            sources = [(digest, exported / f"{index:02}.bin") for index, digest in enumerate(digests)]
            resumed = AcousticStore(root / "resumed", identity, plan)
            with resumed.lock():
                chunks, actual, _ = resumed.load()
                with self.assertRaisesRegex(ValueError, "invalid identity or predecessor"):
                    resumed.restore([sources[1]], chunks, actual)
                with self.assertRaisesRegex(ValueError, "invalid length or digest"):
                    resumed.restore([("0" * 64, sources[0][1])], chunks, actual)
                self.assertEqual(resumed.restore(sources[:1], chunks, actual), 1)
                wrong = encode_chunk(identity, 1, "0" * 64, rows[1])
                alternate = root / "alternate.bin"
                alternate.write_bytes(wrong)
                with self.assertRaisesRegex(ValueError, "invalid identity or predecessor"):
                    resumed.restore([sources[0], (sha256(wrong).hexdigest(), alternate)], chunks, actual)
                self.assertEqual(resumed.load()[0], chunks)
                self.assertEqual(resumed.restore(sources, chunks, actual), 1)
                self.assertEqual(resumed.restore(sources, chunks, actual), 0)
                self.assertEqual(actual, rows)
                self.assertEqual(resumed.export(root / "re-export", actual), digests)

    def test_corruption_recovers_only_the_verified_contiguous_prefix(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            plan = list(windows(50 * 16_000))
            identity = {"taskId": "isolated-example", "revision": 3}
            store = AcousticStore(directory, identity, plan)
            with store.lock():
                chunks = []
                for index in range(3):
                    chunks.append(store.save(chunks, bytes([index + 1]) * plan[index].bytes))
                clean = store.index.read_bytes()
            (directory / (chunks[1]["sha256"] + ".f32")).write_bytes(b"damaged feature")
            (directory / ".pending-index").write_bytes(b"interrupted uncommitted write")
            resumed = AcousticStore(directory, identity, plan)
            with resumed.lock():
                prefix, rows, invalidated = resumed.load()
                self.assertEqual(prefix, chunks[:1])
                self.assertEqual(rows, [b"\x01" * plan[0].bytes])
                self.assertEqual(invalidated, 2)
                for index in range(len(prefix), len(chunks)):
                    prefix.append(resumed.save(prefix, bytes([index + 1]) * plan[index].bytes))
                self.assertEqual(resumed.index.read_bytes(), clean)
                self.assertEqual(resumed.load()[2], 0)

    def test_rejects_stale_identity_and_invalid_index(self):
        with TemporaryDirectory() as temporary:
            directory = Path(temporary)
            plan = list(windows(16_000))
            store = AcousticStore(directory, {"taskId": "original"}, plan)
            with store.lock():
                with self.assertRaisesRegex(ValueError, "invalid feature byte count"):
                    store.save([], b"short")
                store.save([], bytes(plan[0].bytes))
                with self.assertRaisesRegex(ValueError, "identity or plan differs"):
                    AcousticStore(directory, {"taskId": "different"}, plan).load()
                invalid = json.loads(store.index.read_bytes())
                invalid["nextChunk"] += 1
                store.index.write_text(json.dumps(invalid))
                with self.assertRaisesRegex(ValueError, "invalid prefix"):
                    store.load()
