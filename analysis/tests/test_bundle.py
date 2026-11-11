from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import unittest


ROOT = Path(__file__).resolve().parents[1]


class BundleTest(unittest.TestCase):
    def test_build_and_verify_manifest(self):
        with TemporaryDirectory() as temporary:
            out = Path(temporary) / "bundle"
            build = subprocess.run(
                [sys.executable, str(ROOT / "scripts/build_bundle.py"), "--version", "test-v1", "--out-dir", str(out)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(build.returncode, 0, build.stderr)
            manifest = json.loads((out / "manifest.json").read_text())
            bundle = out / "bundle.tar.zst"
            self.assertTrue(bundle.is_file())
            self.assertEqual(manifest["bytes"], bundle.stat().st_size)
            self.assertEqual(manifest["version"], "test-v1")
            verify = subprocess.run(
                [sys.executable, str(ROOT / "scripts/verify_bundle.py"),
                 "--bundle", str(bundle), "--manifest", str(out / "manifest.json")],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(verify.returncode, 0, verify.stderr)
            self.assertTrue(json.loads(verify.stdout)["verified"])

    def test_rejects_tampered_bundle(self):
        with TemporaryDirectory() as temporary:
            out = Path(temporary) / "bundle"
            subprocess.run(
                [sys.executable, str(ROOT / "scripts/build_bundle.py"), "--version", "test-v1", "--out-dir", str(out)],
                capture_output=True, text=True, check=True,
            )
            bundle = out / "bundle.tar.zst"
            bundle.write_bytes(bundle.read_bytes() + b"tamper")
            verify = subprocess.run(
                [sys.executable, str(ROOT / "scripts/verify_bundle.py"),
                 "--bundle", str(bundle), "--manifest", str(out / "manifest.json")],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(verify.returncode, 1, verify.stdout + verify.stderr)


if __name__ == "__main__":
    unittest.main()
