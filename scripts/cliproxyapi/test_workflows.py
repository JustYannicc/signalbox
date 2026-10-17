from __future__ import annotations

import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import Any

from .test_release_policy import hold

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = "apps/cloud/containers/cliproxyapi/release.json"
BRANCH = "automation/cliproxyapi-update"


def step_script(workflow: str, name: str) -> str:
    source = (ROOT / ".github" / "workflows" / workflow).read_text(encoding="utf-8")
    step = source.split(f"      - name: {name}\n", 1)[1].split("      - name:", 1)[0]
    return textwrap.dedent(step.split("        run: |\n", 1)[1])


class WorkflowTests(unittest.TestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp_dir.name)
        self.work = self.directory / "work"
        self.temp = self.directory / "runner"
        self.bin = self.directory / "bin"
        self.output = self.directory / "output"
        self.summary = self.directory / "summary"
        self.main_sha = ""
        self.candidate_sha = ""

    def setUp(self) -> None:
        self.addCleanup(self.temp_dir.cleanup)
        self.work.mkdir()
        self.temp.mkdir()
        self.bin.mkdir()
        self.git("init", "--quiet", "-b", "main")
        self.git("config", "user.name", "Release test")
        self.git("config", "user.email", "release@example.com")
        self.git("config", "commit.gpgsign", "false")
        self.git("config", "core.hooksPath", "/dev/null")
        remote = self.directory / "remote.git"
        self.git("init", "--quiet", "--bare", str(remote))
        self.git("remote", "add", "origin", str(remote))
        gh = self.bin / "gh"
        gh.write_text(
            textwrap.dedent("""\
            #!/usr/bin/env python3
            import json, os, sys
            if sys.argv[1:3] == ["pr", "list"]:
                print("17" if "--jq" in sys.argv else json.dumps([
                    {"number": 17, "headRefOid": os.environ["CANDIDATE_SHA"]}
                ]))
            elif sys.argv[1:3] == ["pr", "checks"]:
                print(json.dumps([
                    {"name": "Deploy preview cloud", "bucket": "pass"},
                    {"name": "CLIProxyAPI container smoke", "bucket": "pass"}
                ]))
            else:
                raise SystemExit("Unexpected GitHub call: " + str(sys.argv))
        """),
            encoding="utf-8",
        )
        gh.chmod(0o755)

    def git(self, *args: str) -> str:
        return subprocess.check_output(
            ["git", *args], cwd=self.work, text=True, stderr=subprocess.DEVNULL
        ).strip()

    def commit(self, manifest: dict[str, Any]) -> str:
        path = self.work / MANIFEST
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(manifest), encoding="utf-8")
        self.git("add", MANIFEST)
        self.git("commit", "--quiet", "-m", "Update release policy")
        return self.git("rev-parse", "HEAD")

    def publish_fixture(self) -> None:
        self.git("push", "--quiet", "origin", "main", BRANCH)
        self.git("checkout", "--quiet", "main")
        (self.temp / "cliproxyapi-current.json").write_text(
            self.git("show", f"main:{MANIFEST}"), encoding="utf-8"
        )

    def run_step(self, workflow: str, name: str, **env: str) -> dict[str, str]:
        result = subprocess.run(
            ["bash", "-e", "-o", "pipefail", "-c", step_script(workflow, name)],
            cwd=self.work,
            env={
                **os.environ,
                "PATH": f"{self.bin}:{os.environ['PATH']}",
                "PYTHONPATH": str(ROOT),
                "RUNNER_TEMP": str(self.temp),
                "GITHUB_OUTPUT": str(self.output),
                "GITHUB_STEP_SUMMARY": str(self.summary),
                "HEAD_BRANCH": BRANCH,
                "HEAD_SHA": "",
                "CANDIDATE_SHA": self.candidate_sha,
                "VERSION": "8.0.17",
                **env,
            },
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return dict(line.split("=", 1) for line in self.output.read_text().splitlines())

    def test_sync_preserves_a_pending_rollback_and_its_new_hold(self) -> None:
        self.main_sha = self.commit({"version": "8.0.16"})
        self.git("checkout", "--quiet", "-b", BRANCH)
        self.candidate_sha = self.commit({"version": "8.0.14", "holds": [hold()]})
        self.publish_fixture()

        result = self.run_step("cliproxyapi-update.yml", "Prepare the update branch")

        self.assertEqual(result["update"], "false")
        self.assertEqual(result["existing_pr"], "17")
        self.assertEqual(self.git("rev-parse", BRANCH), self.candidate_sha)
        self.assertIn("preserving that PR", self.summary.read_text())

    def test_sync_refreshes_stale_candidate_holds_after_person_lifts_them(self) -> None:
        self.commit({"version": "8.0.15", "holds": [hold()]})
        self.git("checkout", "--quiet", "-b", BRANCH)
        self.candidate_sha = self.commit({"version": "8.0.17", "holds": [hold()]})
        self.git("checkout", "--quiet", "main")
        self.main_sha = self.commit({"version": "8.0.15", "holds": []})
        self.publish_fixture()

        result = self.run_step("cliproxyapi-update.yml", "Prepare the update branch")

        self.assertEqual(result["update"], "true")
        self.assertEqual(self.git("rev-parse", BRANCH), self.main_sha)

    def test_main_hold_blocks_existing_green_bump_that_omits_it(self) -> None:
        self.commit({"version": "8.0.15"})
        self.git("checkout", "--quiet", "-b", BRANCH)
        self.candidate_sha = self.commit({"version": "8.0.17"})
        self.git("checkout", "--quiet", "main")
        self.main_sha = self.commit({"version": "8.0.15", "holds": [hold()]})
        self.publish_fixture()

        result = self.run_step(
            "cliproxyapi-auto-merge.yml",
            "Resolve the release PR and current check results",
        )

        self.assertEqual(result["state"], "held")
        self.assertEqual(result["pr"], "17")
        self.assertIn("auto-merge stays disabled", self.summary.read_text())

    def test_good_rollback_passes_the_existing_smoke_and_deploy_gate(self) -> None:
        self.main_sha = self.commit({"version": "8.0.16"})
        self.git("checkout", "--quiet", "-b", BRANCH)
        self.candidate_sha = self.commit({"version": "8.0.14", "holds": [hold()]})
        self.publish_fixture()

        result = self.run_step(
            "cliproxyapi-auto-merge.yml",
            "Resolve the release PR and current check results",
            HEAD_SHA=self.candidate_sha,
        )

        self.assertEqual(result["state"], "ready")
        self.assertEqual(result["head_sha"], self.candidate_sha)


if __name__ == "__main__":
    unittest.main()
