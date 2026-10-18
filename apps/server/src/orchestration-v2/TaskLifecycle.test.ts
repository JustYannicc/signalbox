import { assert, it } from "@effect/vitest";
import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  archiveSettledTask,
  reopenArchivedTask,
  reopenForUserMessage,
  taskCompletionSnapshotIsStale,
} from "./TaskLifecycle.ts";

const at = DateTime.makeUnsafe("2026-10-17T10:00:00.000Z");
const baseThread = {
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  unsettledAt: null,
  pinnedAt: at,
  pinOrderKey: "pin-order-1",
  activeOrderKey: "active-order-1",
  title: "A task",
  branch: "feature/task",
  worktreePath: "/work/task",
} as OrchestrationV2AppThread;

it("rejects task completion snapshots after changes and while any run is live or queued", () => {
  assert.isTrue(
    taskCompletionSnapshotIsStale({
      thread: { ...baseThread, updatedAt: DateTime.add(at, { milliseconds: 1 }) },
      runs: [],
      snapshotAt: at,
    }),
  );
  for (const status of ["preparing", "starting", "running", "waiting", "queued"] as const) {
    assert.isTrue(
      taskCompletionSnapshotIsStale({
        thread: baseThread,
        runs: [{ status }],
        snapshotAt: at,
      }),
      `${status} should keep the task open`,
    );
  }
  assert.isFalse(
    taskCompletionSnapshotIsStale({
      thread: { ...baseThread, settledOverride: "active" },
      runs: [],
      snapshotAt: at,
    }),
    "a reopened task may complete against a new snapshot",
  );
});

it("uses archive and settlement as one reversible task state", () => {
  const archived = archiveSettledTask(baseThread, at);
  assert.equal(archived.archivedAt, at);
  assert.equal(archived.settledOverride, "settled");
  assert.equal(archived.settledAt, at);
  assert.equal(archived.pinnedAt, baseThread.pinnedAt);
  assert.equal(archived.pinOrderKey, baseThread.pinOrderKey);
  assert.equal(archived.activeOrderKey, baseThread.activeOrderKey);
  assert.equal(archived.branch, baseThread.branch);
  assert.equal(archived.worktreePath, baseThread.worktreePath);

  const reopened = reopenArchivedTask(archived, DateTime.add(at, { seconds: 1 }));
  assert.isNull(reopened.archivedAt);
  assert.equal(reopened.settledOverride, "active");
  assert.isNull(reopened.settledAt);
  assert.equal(reopened.pinnedAt, baseThread.pinnedAt);
  assert.equal(reopened.pinOrderKey, baseThread.pinOrderKey);
  assert.equal(reopened.activeOrderKey, baseThread.activeOrderKey);
  assert.equal(reopened.title, baseThread.title);
  assert.equal(reopened.branch, baseThread.branch);
  assert.equal(reopened.worktreePath, baseThread.worktreePath);
});

it("clears both archived and settled state when the person replies", () => {
  const reopened = reopenForUserMessage(
    archiveSettledTask(baseThread, at),
    DateTime.add(at, { seconds: 1 }),
  );
  assert.isNull(reopened.archivedAt);
  assert.isNull(reopened.settledOverride);
  assert.isNull(reopened.settledAt);
  assert.equal(reopened.branch, baseThread.branch);
  assert.equal(reopened.worktreePath, baseThread.worktreePath);
});
