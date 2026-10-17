from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

from .release_policy import matching_holds


def hold(**changes: Any) -> dict[str, Any]:
    return {
        "from": "8.0.16",
        "reason": "The scripted regression fails on this release.",
        "upstreamIssue": "https://github.com/router-for-me/CLIProxyAPI/issues/123",
        "reproduction": "https://example.com/reproduction",
        "lastGood": {
            "commit": "a" * 40,
            "version": "8.0.14",
            "evidence": "https://example.com/good-release-proof",
        },
        **changes,
    }


class ReleasePolicyTests(unittest.TestCase):
    def test_open_range_blocks_the_bad_release_and_newer_releases(self) -> None:
        manifest = {"holds": [hold()]}
        self.assertFalse(matching_holds("8.0.15", manifest))
        self.assertTrue(matching_holds("8.0.16", manifest))
        self.assertTrue(matching_holds("9.0.0", manifest))

    def test_range_uses_numeric_versions_and_excludes_the_fixed_release(self) -> None:
        manifest = {
            "holds": [
                hold(
                    **{
                        "from": "8.0.9",
                        "before": "8.0.11",
                        "lastGood": {
                            "commit": "a" * 40,
                            "version": "8.0.8",
                            "evidence": "https://example.com/proof",
                        },
                    }
                )
            ]
        }
        self.assertFalse(matching_holds("8.0.8", manifest))
        self.assertTrue(matching_holds("8.0.9", manifest))
        self.assertTrue(matching_holds("8.0.10", manifest))
        self.assertFalse(matching_holds("8.0.11", manifest))

    def test_candidate_cannot_remove_a_hold_from_main(self) -> None:
        self.assertTrue(
            matching_holds("8.0.16", {"holds": [hold()]}, {"version": "8.0.16"})
        )

    def test_candidate_cannot_add_a_hold_covering_its_own_pin(self) -> None:
        self.assertTrue(matching_holds("8.0.16", {}, {"holds": [hold()]}))

    def test_person_can_lift_the_hold_on_main(self) -> None:
        self.assertFalse(matching_holds("8.0.16", {"holds": []}, {"holds": []}))
        self.assertFalse(matching_holds("8.0.16", {}))

    def test_invalid_policy_fails_even_outside_its_range(self) -> None:
        for field, value in [
            ("from", "v8.0.16"),
            ("before", "8.0.16"),
            ("reason", ""),
            ("reason", "first\nsecond"),
            ("upstreamIssue", "https://example.com/unrelated"),
            ("reproduction", "http://example.com/reproduction"),
            (
                "lastGood",
                {
                    "commit": "main",
                    "version": "8.0.15",
                    "evidence": "https://example.com",
                },
            ),
            (
                "lastGood",
                {
                    "commit": "a" * 40,
                    "version": "8.0.16",
                    "evidence": "https://example.com",
                },
            ),
            ("lastGood", {"commit": "a" * 40, "version": "8.0.15"}),
        ]:
            with self.subTest(field=field, value=value), self.assertRaises(SystemExit):
                entry = copy.deepcopy(hold())
                entry[field] = value
                matching_holds("1.0.0", {"holds": [entry]})
        for entries in [None, {}, [None]]:
            with self.subTest(entries=entries), self.assertRaises(SystemExit):
                matching_holds("8.0.16", {"holds": entries})

    def test_workflow_cli_checks_both_main_and_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            current = Path(directory) / "current.json"
            candidate = Path(directory) / "candidate.json"
            current.write_text(json.dumps({"holds": [hold()]}), encoding="utf-8")
            candidate.write_text("{}", encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "scripts.cliproxyapi.release_policy",
                    str(current),
                    "8.0.16",
                    str(candidate),
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            policy = json.loads(result.stdout)
            self.assertTrue(policy["held"])
            self.assertEqual(
                policy["holds"][0]["upstreamIssue"], hold()["upstreamIssue"]
            )


if __name__ == "__main__":
    unittest.main()
