from __future__ import annotations

import json
import unittest
from typing import Any

from .test_release_policy import hold
from .test_rollback import release
from .workflow_test_support import BRANCH, MANIFEST, WorkflowCase

SYNC = "cliproxyapi-update.yml"
MERGE = "cliproxyapi-auto-merge.yml"
PREPARE = "Prepare an evidenced rollback for a held pin"
GATE = "Resolve the release PR and current check results"


class BackstopWorkflowTests(WorkflowCase):
    def test_failed_final_policy_read_disables_old_auto_merge(self) -> None:
        self.commit({"version": "8.0.15"})
        self.git("checkout", "--quiet", "-b", BRANCH)
        self.candidate_sha = self.commit({"version": "8.0.17"})
        self.git("checkout", "--quiet", "main")
        self.main_sha = self.commit({"version": "8.0.15", "holds": None})
        self.publish_fixture()
        self.run_step(
            MERGE,
            "Enable GitHub auto-merge",
            expect_failure=True,
            PR="17",
            BACKSTOP="false",
        )
        self.run_step(MERGE, "Report an auto-merge workflow problem", PR="17")
        self.assertTrue(any("--disable-auto" in call for call in self.calls()))
        self.assertFalse(any("--auto" in call for call in self.calls()))

    def held_pin(self) -> tuple[dict[str, Any], dict[str, Any]]:
        good = release("8.0.14")
        good_commit = self.commit(good)
        entry = hold(
            lastGood={
                "version": "8.0.14",
                "commit": good_commit,
                "evidence": "https://example.com/good-release-proof",
            }
        )
        current = {**release("8.0.17"), "holds": [entry]}
        self.main_sha = self.commit(current)
        self.git("push", "--quiet", "origin", "main")
        return good, current

    def test_already_merged_held_pin_gets_a_full_reported_rollback_through_the_gate(
        self,
    ) -> None:
        good, current = self.held_pin()
        prepared = self.run_step(SYNC, PREPARE, PR_EXISTS="false")
        self.assertEqual(prepared["version"], "8.0.14")
        self.assertEqual(prepared["previous"], "8.0.17")
        self.assertEqual(prepared["push"], "true")
        self.run_step(
            SYNC,
            "Describe the evidenced rollback",
            VERSION=prepared["version"],
            BRANCH=BRANCH,
        )
        self.run_step(
            SYNC,
            "Commit and push the update branch",
            VERSION=prepared["version"],
            BRANCH=BRANCH,
            EXPECTED_BASE=prepared["base_sha"],
            EXPECTED_BRANCH=prepared["branch_sha"],
        )
        self.candidate_sha = self.git("rev-parse", f"origin/{BRANCH}")
        self.run_step(
            SYNC,
            "Create the release pull request",
            BRANCH=BRANCH,
            TAG="",
            ROLLBACK_VERSION=prepared["version"],
        )
        self.run_step(
            SYNC,
            "Report the held-pin rollback",
            PREVIOUS=prepared["previous"],
            VERSION=prepared["version"],
            BRANCH=BRANCH,
        )
        pr_state = json.loads(self.state.read_text())
        self.assertIn("cli-proxyapi-rollback", pr_state["labels"])
        for evidence in (
            current["holds"][0]["upstreamIssue"],
            current["holds"][0]["reproduction"],
            current["holds"][0]["lastGood"]["evidence"],
        ):
            self.assertIn(evidence, pr_state["body"])
        self.assertTrue(pr_state["issue"])

        gate = self.run_step(MERGE, GATE, HEAD_SHA=self.candidate_sha)
        self.assertEqual(gate["state"], "ready")
        self.assertEqual(gate["backstop"], "true")
        self.run_step(MERGE, "Enable GitHub auto-merge", PR="17", BACKSTOP="true")
        self.assertTrue(
            any(
                "--auto" in call and self.candidate_sha in call for call in self.calls()
            )
        )
        restored = json.loads(self.git("show", f"origin/{BRANCH}:{MANIFEST}"))
        self.assertEqual({k: v for k, v in restored.items() if k != "holds"}, good)
        self.assertEqual(restored["holds"], current["holds"])
        # Simulate GitHub accepting that gated PR in the local fixture repository.
        self.git("checkout", "--quiet", "main")
        self.git("merge", "--ff-only", f"origin/{BRANCH}")
        self.git("push", "--quiet", "origin", "main")
        again = self.run_step(SYNC, PREPARE)
        self.assertEqual(again["rollback"], "false")
        self.assertEqual(
            len([call for call in self.calls() if call[:2] == ["pr", "create"]]), 1
        )

    def test_pending_identical_rollback_keeps_its_head_checks_and_holds(self) -> None:
        good, current = self.held_pin()
        self.git("checkout", "--quiet", "-b", BRANCH)
        self.candidate_sha = self.commit({**good, "holds": current["holds"]})
        self.publish_fixture()
        first = self.run_step(SYNC, PREPARE)
        self.assertEqual(first["push"], "false")
        self.assertEqual(self.git("rev-parse", f"origin/{BRANCH}"), self.candidate_sha)
        self.assertEqual(
            json.loads((self.work / MANIFEST).read_text())["holds"], current["holds"]
        )
        self.assertFalse(any(call[:2] == ["pr", "merge"] for call in self.calls()))

    def test_backstop_preserves_unrelated_branch_changes(self) -> None:
        self.held_pin()
        self.git("checkout", "--quiet", "-b", BRANCH)
        (self.work / "unrelated.txt").write_text("Keep this work.")
        self.git("add", "unrelated.txt")
        self.git("commit", "--quiet", "-m", "Unrelated work")
        self.candidate_sha = self.git("rev-parse", "HEAD")
        self.publish_fixture()
        self.run_step(SYNC, PREPARE, expect_failure=True)
        self.assertEqual(self.git("rev-parse", BRANCH), self.candidate_sha)
        self.assertEqual(self.git("rev-parse", f"origin/{BRANCH}"), self.candidate_sha)

    def test_backstop_preserves_unmerged_hold_edits_on_the_branch(self) -> None:
        good, current = self.held_pin()
        self.git("checkout", "--quiet", "-b", BRANCH)
        self.candidate_sha = self.commit(
            {**good, "holds": [*current["holds"], hold(**{"from": "9.0.0"})]}
        )
        self.publish_fixture()
        self.run_step(SYNC, PREPARE, expect_failure=True)
        self.assertEqual(self.git("rev-parse", BRANCH), self.candidate_sha)

    def test_human_lift_during_preparation_stops_push(self) -> None:
        _, current = self.held_pin()
        prepared = self.run_step(SYNC, PREPARE, PR_EXISTS="false")
        content = (self.work / MANIFEST).read_text()
        self.git("restore", MANIFEST)
        self.git("checkout", "--quiet", "main")
        self.main_sha = self.commit({**current, "holds": []})
        self.git("push", "--quiet", "origin", "main")
        self.git("checkout", "--quiet", BRANCH)
        (self.work / MANIFEST).write_text(content)
        self.run_step(
            SYNC,
            "Commit and push the update branch",
            expect_failure=True,
            VERSION=prepared["version"],
            BRANCH=BRANCH,
            EXPECTED_BASE=prepared["base_sha"],
            EXPECTED_BRANCH=prepared["branch_sha"],
        )
        self.assertEqual(self.git("ls-remote", "--heads", "origin", BRANCH), "")
        self.assertEqual(
            json.loads(self.git("show", f"origin/main:{MANIFEST}"))["holds"], []
        )

    def test_existing_backstop_does_not_reintroduce_a_human_lift(self) -> None:
        good, current = self.held_pin()
        self.git("checkout", "--quiet", "-b", BRANCH)
        self.candidate_sha = self.commit({**good, "holds": current["holds"]})
        self.git("checkout", "--quiet", "main")
        self.main_sha = self.commit({**current, "holds": []})
        self.publish_fixture()
        self.state.write_text(
            json.dumps(
                {
                    "exists": True,
                    "auto": True,
                    "labels": ["cli-proxyapi-update", "cli-proxyapi-rollback"],
                }
            )
        )
        gate = self.run_step(MERGE, GATE)
        self.assertEqual(gate["state"], "held")

    def test_hold_widened_during_checks_is_read_again_before_merge(self) -> None:
        entry = hold(before="8.0.17")
        self.main_sha = self.commit({"version": "8.0.15", "holds": [entry]})
        self.git("checkout", "--quiet", "-b", BRANCH)
        self.candidate_sha = self.commit({"version": "8.0.17", "holds": [entry]})
        self.git("checkout", "--quiet", "main")
        wider = self.commit({"version": "8.0.15", "holds": [hold(before="8.0.18")]})
        self.git("reset", "--hard", self.main_sha)
        self.publish_fixture()
        gate = self.run_step(MERGE, GATE, ADVANCE_MAIN_ON_CHECKS=wider)
        self.assertEqual(gate["state"], "ready")
        self.run_step(MERGE, "Enable GitHub auto-merge", PR="17", BACKSTOP="false")
        self.assertTrue(any("--disable-auto" in call for call in self.calls()))
        self.assertFalse(any("--auto" in call for call in self.calls()))
        self.assertIn("final hold recheck blocked", self.summary.read_text())

    def test_held_target_requires_matching_snapshot_and_unheld_release(self) -> None:
        self.commit(release("8.0.12"))
        for changes in ["version", "source", "held"]:
            with self.subTest(changes=changes):
                self.git("checkout", "--quiet", "main")
                good = release("8.0.14")
                if changes == "source":
                    good["source"] = {}
                commit = self.commit(good)
                entry = hold(
                    lastGood={
                        "version": "8.0.13" if changes == "version" else "8.0.14",
                        "commit": commit,
                        "evidence": "https://example.com/proof",
                    }
                )
                entries = [entry]
                if changes == "held":
                    entries.append(
                        hold(
                            **{
                                "from": "8.0.14",
                                "before": "8.0.16",
                                "lastGood": {
                                    "version": "8.0.13",
                                    "commit": commit,
                                    "evidence": "https://example.com/proof",
                                },
                            }
                        )
                    )
                self.main_sha = self.commit({**release("8.0.17"), "holds": entries})
                self.git("push", "--quiet", "origin", "main")
                self.run_step(SYNC, PREPARE, expect_failure=True, PR_EXISTS="false")
                expected = {
                    "version": "does not match",
                    "source": "full upstream source commit",
                    "held": "Every evidenced rollback target is held",
                }[changes]
                self.assertIn(expected, self.last_stderr)


if __name__ == "__main__":
    unittest.main()
