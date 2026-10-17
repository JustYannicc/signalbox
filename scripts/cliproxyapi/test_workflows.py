from __future__ import annotations

import unittest

from .test_release_policy import hold
from .workflow_test_support import BRANCH, WorkflowCase


class WorkflowTests(WorkflowCase):
    def test_late_old_completion_reconciles_the_current_rollback(self) -> None:
        self.main_sha = self.commit({"version": "8.0.16"})
        self.git("checkout", "--quiet", "-b", BRANCH)
        old_head = self.commit({"version": "8.0.17"})
        self.candidate_sha = self.commit({"version": "8.0.14", "holds": [hold()]})
        self.publish_fixture()
        gate = "Resolve the release PR and current check results"

        pending = self.run_step(
            "cliproxyapi-auto-merge.yml",
            gate,
            HEAD_SHA=self.candidate_sha,
            CHECKS_PENDING="true",
        )
        self.assertEqual(pending["state"], "waiting")

        # An older completion can replace the current head's pending workflow run.
        ready = self.run_step("cliproxyapi-auto-merge.yml", gate, HEAD_SHA=old_head)
        self.assertEqual(ready["state"], "ready")
        self.assertEqual(ready["head_sha"], self.candidate_sha)
        self.run_step(
            "cliproxyapi-auto-merge.yml",
            "Enable GitHub auto-merge",
            PR="17",
            BACKSTOP="false",
        )
        merges = [call for call in self.calls() if call[:2] == ["pr", "merge"]]
        self.assertIn(
            [
                "pr",
                "merge",
                "17",
                "--auto",
                "--squash",
                "--match-head-commit",
                self.candidate_sha,
            ],
            merges,
        )

    def test_normal_sync_preserves_unrelated_branch_changes(self) -> None:
        self.main_sha = self.commit({"version": "8.0.15"})
        self.git("checkout", "--quiet", "-b", BRANCH)
        self.commit({"version": "8.0.16"})
        (self.work / "unrelated.txt").write_text("Keep this work.")
        self.git("add", "unrelated.txt")
        self.git("commit", "--quiet", "-m", "Unrelated work")
        self.candidate_sha = self.git("rev-parse", "HEAD")
        self.publish_fixture()
        self.run_step(
            "cliproxyapi-update.yml", "Prepare the update branch", expect_failure=True
        )
        self.assertEqual(self.git("rev-parse", BRANCH), self.candidate_sha)

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
