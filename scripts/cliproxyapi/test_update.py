from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).parent
TESTDATA = ROOT / "testdata"
UPDATE_SCRIPT = ROOT / "update.py"
SOURCE_COMMIT = "0" * 40


class UpdateTests(unittest.TestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp_dir.name)
        self.release_path = self.directory / "latest-release.json"
        self.checksums_path = self.directory / "checksums.txt"
        self.manifest_path = self.directory / "release.json"
        self.original_manifest = ""

    def setUp(self) -> None:
        shutil.copyfile(TESTDATA / "latest-release.json", self.release_path)
        shutil.copyfile(TESTDATA / "checksums.txt", self.checksums_path)
        shutil.copyfile(TESTDATA / "pinned-release.json", self.manifest_path)
        self.original_manifest = self.manifest_path.read_text(encoding="utf-8")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def update(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "python3",
                str(UPDATE_SCRIPT),
                str(self.release_path),
                str(self.checksums_path),
                SOURCE_COMMIT,
                str(self.manifest_path),
            ],
            capture_output=True,
            check=False,
            text=True,
        )

    def assert_manifest_unchanged(self) -> None:
        self.assertEqual(self.manifest_path.read_text(encoding="utf-8"), self.original_manifest)

    def test_updates_one_manifest_with_all_verified_assets(self) -> None:
        result = self.update()

        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["version"], "8.0.16")
        self.assertEqual(manifest["source"], {"commit": SOURCE_COMMIT})
        self.assertEqual(len(manifest["platforms"]), 6)
        self.assertEqual(manifest["platforms"]["darwin-arm64"]["sha256"], "0" * 64)
        self.assertEqual(
            manifest["container"]["name"], "CLIProxyAPI_8.0.16_linux_amd64_no-plugin.tar.gz"
        )
        self.assertEqual(manifest["container"]["sha256"], "6" * 64)
        self.assertIn("version=8.0.16", result.stdout)

    def test_missing_release_asset_leaves_manifest_unchanged(self) -> None:
        release = json.loads(self.release_path.read_text(encoding="utf-8"))
        release["assets"].pop()
        self.release_path.write_text(json.dumps(release), encoding="utf-8")

        result = self.update()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing the required asset", result.stderr)
        self.assert_manifest_unchanged()

    def test_missing_checksum_leaves_manifest_unchanged(self) -> None:
        checksums = self.checksums_path.read_text(encoding="utf-8").splitlines()
        self.checksums_path.write_text("\n".join(checksums[:-1]) + "\n", encoding="utf-8")

        result = self.update()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing a valid SHA-256", result.stderr)
        self.assert_manifest_unchanged()

    def test_invalid_checksum_leaves_manifest_unchanged(self) -> None:
        checksums = self.checksums_path.read_text(encoding="utf-8").replace(
            "0" * 64, "z" * 64, 1
        )
        self.checksums_path.write_text(checksums, encoding="utf-8")

        result = self.update()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing a valid SHA-256", result.stderr)
        self.assert_manifest_unchanged()

    def test_invalid_source_commit_leaves_manifest_unchanged(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(UPDATE_SCRIPT),
                str(self.release_path),
                str(self.checksums_path),
                "not-a-commit",
                str(self.manifest_path),
            ],
            capture_output=True,
            check=False,
            text=True,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("full upstream source commit hash", result.stderr)
        self.assert_manifest_unchanged()

    def test_prerelease_leaves_manifest_unchanged(self) -> None:
        release = json.loads(self.release_path.read_text(encoding="utf-8"))
        release["prerelease"] = True
        self.release_path.write_text(json.dumps(release), encoding="utf-8")

        result = self.update()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Expected a stable", result.stderr)
        self.assert_manifest_unchanged()


if __name__ == "__main__":
    unittest.main()
