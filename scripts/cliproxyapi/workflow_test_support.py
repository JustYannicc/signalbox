from __future__ import annotations

import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = "apps/cloud/containers/cliproxyapi/release.json"
BRANCH = "automation/cliproxyapi-update"


def step_script(workflow: str, name: str) -> str:
    source = (ROOT / ".github" / "workflows" / workflow).read_text(encoding="utf-8")
    step = source.split(f"      - name: {name}\n", 1)[1].split("      - name:", 1)[0]
    if "        run: |\n" in step:
        return textwrap.dedent(step.split("        run: |\n", 1)[1])
    return step.split("        run: ", 1)[1].splitlines()[0]


class WorkflowCase(unittest.TestCase):
    def __init__(self, methodName: str = "runTest") -> None:
        super().__init__(methodName)
        self.temp_dir = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp_dir.name)
        self.work = self.directory / "work"
        self.temp = self.directory / "runner"
        self.bin = self.directory / "bin"
        self.output = self.directory / "output"
        self.summary = self.directory / "summary"
        self.log = self.directory / "gh-log"
        self.state = self.directory / "gh-state"
        self.main_sha = ""
        self.candidate_sha = ""
        self.last_stderr = ""

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
        scripts = self.work / "scripts" / "cliproxyapi"
        scripts.mkdir(parents=True)
        (scripts / "report-problem.mjs").write_text(
            (ROOT / "scripts" / "cliproxyapi" / "report-problem.mjs").read_text(),
            encoding="utf-8",
        )
        gh = self.bin / "gh"
        gh.write_text(
            textwrap.dedent("""\
            #!/usr/bin/env python3
            import json, os, subprocess, sys
            from pathlib import Path
            args = sys.argv[1:]
            with open(os.environ["GH_LOG"], "a") as log:
                log.write(json.dumps(args) + "\\n")
            path = Path(os.environ["GH_STATE"])
            state = json.loads(path.read_text()) if path.exists() else {
                "exists": os.environ.get("PR_EXISTS", "true") == "true",
                "auto": True, "labels": ["cli-proxyapi-update"]
            }
            url = "https://github.com/example/project/pull/17"
            if args[:2] == ["pr", "list"]:
                pr = {"number": 17, "headRefOid": os.environ["CANDIDATE_SHA"],
                      "baseRefName": "main", "labels": [{"name": x} for x in state["labels"]]}
                print(("17" if state["exists"] else "") if "--jq" in args
                      else json.dumps([pr] if state["exists"] else []))
            elif args[:2] == ["pr", "checks"]:
                if os.environ.get("ADVANCE_MAIN_ON_CHECKS"):
                    subprocess.run(["git", "push", "--quiet", "origin",
                        os.environ["ADVANCE_MAIN_ON_CHECKS"] + ":refs/heads/main"], check=True)
                bucket = "pending" if os.environ.get("CHECKS_PENDING") else "pass"
                print(json.dumps([
                    {"name": "Deploy preview cloud", "bucket": bucket},
                    {"name": "CLIProxyAPI container smoke", "bucket": bucket}
                ]))
            elif args[:2] == ["pr", "view"]:
                field = args[args.index("--json") + 1]
                print(url if field == "url" else str(
                    "cli-proxyapi-rollback" in state["labels"] if field == "labels" else state["auto"]
                ).lower())
            elif args[:2] == ["pr", "merge"]:
                state["auto"] = "--disable-auto" not in args
            elif args[:2] in (["pr", "create"], ["pr", "edit"]):
                state["exists"] = True
                for flag in ("--add-label", "--label"):
                    for index, value in enumerate(args[:-1]):
                        if value == flag and args[index + 1] not in state["labels"]:
                            state["labels"].append(args[index + 1])
                if "--remove-label" in args:
                    state["labels"].remove(args[args.index("--remove-label") + 1])
                if "--body-file" in args:
                    state["body"] = Path(args[args.index("--body-file") + 1]).read_text()
                if args[1] == "create": print(url)
            elif args[:2] == ["label", "create"]:
                pass
            elif args[:2] == ["issue", "list"]:
                print("18" if state.get("issue") else "")
            elif args[:2] in (["issue", "create"], ["issue", "edit"]):
                state["issue"] = True
            elif args[:2] == ["issue", "close"]:
                state["issue"] = False
            else:
                raise SystemExit("Unexpected GitHub call: " + str(args))
            path.write_text(json.dumps(state))
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

    def calls(self) -> list[list[str]]:
        return (
            [json.loads(line) for line in self.log.read_text().splitlines()]
            if self.log.exists()
            else []
        )

    def run_step(
        self, workflow: str, name: str, expect_failure: bool = False, **env: str
    ) -> dict[str, str]:
        result = subprocess.run(
            ["bash", "-e", "-o", "pipefail", "-c", step_script(workflow, name)],
            cwd=self.work,
            env={
                **os.environ,
                "PATH": f"{self.bin}:{os.environ['PATH']}",
                "PYTHONPATH": str(ROOT),
                "GITHUB_WORKSPACE": str(ROOT),
                "RUNNER_TEMP": str(self.temp),
                "GITHUB_OUTPUT": str(self.output),
                "GITHUB_STEP_SUMMARY": str(self.summary),
                "GH_LOG": str(self.log),
                "GH_STATE": str(self.state),
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
        self.last_stderr = result.stderr
        if expect_failure:
            self.assertNotEqual(result.returncode, 0, result.stdout)
        else:
            self.assertEqual(result.returncode, 0, result.stderr)
        return (
            dict(line.split("=", 1) for line in self.output.read_text().splitlines())
            if self.output.exists()
            else {}
        )
