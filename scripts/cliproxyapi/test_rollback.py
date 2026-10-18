from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

from .test_release_policy import hold
from .update import CONTAINER_ARCHIVE, PLATFORMS

ROOT = Path(__file__).resolve().parents[2]


def release(version: str) -> dict[str, Any]:
    def asset(name: str) -> dict[str, Any]:
        return {"name": name, "bytes": 123, "sha256": "a" * 64}

    return {
        "version": version,
        "source": {"commit": "b" * 40},
        "platforms": {
            platform: asset(
                f"CLIProxyAPI_{version}_{arch}."
                f"{'zip' if platform.startswith('win32-') else 'tar.gz'}"
            )
            for platform, arch in PLATFORMS.items()
        },
        "container": asset(CONTAINER_ARCHIVE.format(version=version)),
    }


class RollbackTests(unittest.TestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp_dir.name)
        self.manifest = self.directory / "release.json"
        self.good = release("8.0.14")
        self.good_commit = ""
        self.current = release("8.0.16")

    def setUp(self) -> None:
        self.addCleanup(self.temp_dir.cleanup)
        self.git("init", "--quiet")
        self.git("config", "user.name", "Release test")
        self.git("config", "user.email", "release@example.com")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.hooksPath", "/dev/null")
        self.good_commit = self.commit(self.good)
        self.commit(release("8.0.15"))
        self.commit(self.current)

    def git(self, *args: str) -> str:
        return subprocess.check_output(
            ["git", *args], cwd=self.directory, text=True
        ).strip()

    def commit(self, manifest: dict[str, Any]) -> str:
        self.manifest.write_text(json.dumps(manifest), encoding="utf-8")
        self.git("add", "release.json")
        self.git("commit", "--quiet", "-m", f"Pin {manifest['version']}")
        return self.git("rev-parse", "HEAD")

    def rollback(self, **changes: str) -> subprocess.CompletedProcess[str]:
        options = {
            "expected-version": "8.0.16",
            "good-commit": self.good_commit,
            "good-evidence": "https://example.com/good-release-proof",
            "reproduction": "https://example.com/reproduction",
            "upstream-issue": "https://github.com/router-for-me/CLIProxyAPI/issues/123",
            "reason": "The scripted regression fails on this release.",
            **changes,
        }
        args = [
            sys.executable,
            "-m",
            "scripts.cliproxyapi.rollback",
            str(self.manifest),
        ]
        for key, value in options.items():
            args.extend([f"--{key}", value])
        return subprocess.run(
            args,
            cwd=self.directory,
            env={**os.environ, "PYTHONPATH": str(ROOT)},
            text=True,
            capture_output=True,
            check=False,
        )

    def assert_unchanged(self, original: str) -> None:
        self.assertEqual(self.manifest.read_text(encoding="utf-8"), original)

    def test_restores_evidenced_release_instead_of_blindly_previous_pin(self) -> None:
        result = self.rollback()

        self.assertEqual(result.returncode, 0, result.stderr)
        updated = json.loads(self.manifest.read_text(encoding="utf-8"))
        self.assertEqual(
            {key: value for key, value in updated.items() if key != "holds"}, self.good
        )
        entry = updated["holds"][0]
        self.assertEqual(
            entry,
            hold(
                lastGood={
                    "commit": self.good_commit,
                    "version": "8.0.14",
                    "evidence": "https://example.com/good-release-proof",
                }
            ),
        )
        self.assertIn(entry["upstreamIssue"], result.stdout)
        self.assertIn(entry["reproduction"], result.stdout)
        # Retrying the same input must not add another hold or change the pin.
        original = self.manifest.read_text(encoding="utf-8")
        self.assertNotEqual(self.rollback().returncode, 0)
        self.assert_unchanged(original)

    def test_preserves_current_holds_without_restoring_lifted_historical_holds(
        self,
    ) -> None:
        self.good["holds"] = [
            hold(
                **{
                    "from": "7.0.0",
                    "lastGood": {
                        "commit": "a" * 40,
                        "version": "6.0.0",
                        "evidence": "https://example.com/proof",
                    },
                }
            )
        ]
        self.good_commit = self.commit(self.good)
        existing = hold(**{"from": "9.0.0"})
        self.current["holds"] = [existing]
        self.commit(self.current)

        result = self.rollback()

        self.assertEqual(result.returncode, 0, result.stderr)
        entries = json.loads(self.manifest.read_text(encoding="utf-8"))["holds"]
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[0], existing)
        self.assertEqual(entries[1]["from"], "8.0.16")

    def test_rejects_missing_evidence_stale_requests_and_nonancestral_targets(
        self,
    ) -> None:
        for changes in [
            {"good-evidence": ""},
            {"reproduction": ""},
            {"upstream-issue": ""},
            {"expected-version": "8.0.17"},
            {"good-commit": "HEAD~1"},
            {"good-commit": "f" * 40},
            {"good-commit": self.git("rev-parse", "HEAD")},
        ]:
            with self.subTest(changes=changes):
                original = self.manifest.read_text(encoding="utf-8")
                result = self.rollback(**changes)
                self.assertNotEqual(result.returncode, 0)
                self.assert_unchanged(original)

    def test_rejects_incomplete_or_mismatched_release_snapshots(self) -> None:
        for field, value in [
            ("source", {}),
            ("platforms", {}),
            (
                "container",
                {
                    "name": CONTAINER_ARCHIVE.format(version="8.0.15"),
                    "bytes": 1,
                    "sha256": "a" * 64,
                },
            ),
            (
                "container",
                {
                    "name": CONTAINER_ARCHIVE.format(version="8.0.14"),
                    "bytes": True,
                    "sha256": "a" * 64,
                },
            ),
            (
                "container",
                {
                    "name": CONTAINER_ARCHIVE.format(version="8.0.14"),
                    "bytes": 1,
                    "sha256": "invalid",
                },
            ),
        ]:
            with self.subTest(field=field, value=value):
                good = release("8.0.14")
                good[field] = value
                self.good_commit = self.commit(good)
                self.commit(self.current)
                original = self.manifest.read_text(encoding="utf-8")
                self.assertNotEqual(self.rollback().returncode, 0)
                self.assert_unchanged(original)

    def test_rejects_a_good_release_that_another_hold_covers(self) -> None:
        self.current["holds"] = [
            hold(
                **{
                    "from": "8.0.14",
                    "lastGood": {
                        "commit": "a" * 40,
                        "version": "8.0.13",
                        "evidence": "https://example.com/proof",
                    },
                }
            )
        ]
        self.commit(self.current)
        original = self.manifest.read_text(encoding="utf-8")

        result = self.rollback()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("itself held", result.stderr)
        self.assert_unchanged(original)


if __name__ == "__main__":
    unittest.main()
