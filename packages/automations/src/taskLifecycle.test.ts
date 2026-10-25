import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";

import { makeTaskRecords } from "./taskLifecycle.ts";

describe("task lifecycle records", () => {
  it.effect("reloads conditions, settles and reopens, and rejects stale or repeated commands", () =>
    Effect.gen(function* () {
      const records = yield* makeTaskRecords;
      const proposed = yield* records.propose({
        threadId: "thread-1",
        summary: "The pull request merges",
        automationId: "task-done-condition",
        runId: "run-1",
        input: { conditions: [{ type: "pull-request.merged", number: 671 }] },
        commandId: "propose-1",
      });
      expect(proposed.applied).toBe(true);
      expect(proposed.record?.generation).toBe(1);

      const reloaded = yield* makeTaskRecords;
      const read = yield* reloaded.read("thread-1");
      expect(read).toMatchObject({
        condition: {
          summary: "The pull request merges",
          automationId: "task-done-condition",
          runId: "run-1",
          input: { conditions: [{ type: "pull-request.merged", number: 671 }] },
        },
        generation: 1,
        settledAt: null,
      });

      const stale = yield* records.complete({
        threadId: "thread-1",
        outcome: "Merged",
        expectedGeneration: 0,
        commandId: "stale-complete",
      });
      expect(stale.applied).toBe(false);
      expect(stale.record?.generation).toBe(1);

      const completed = yield* records.complete({
        threadId: "thread-1",
        outcome: "The pull request merged",
        settledAt: "2026-10-16T10:00:00.000Z",
        expectedGeneration: 1,
        expectedUpdatedAt: read?.updatedAt,
        commandId: "complete-1",
      });
      expect(completed.applied).toBe(true);
      expect(completed.record).toMatchObject({
        outcome: "The pull request merged",
        reason: null,
        uncertain: false,
        settledAt: "2026-10-16T10:00:00.000Z",
        generation: 2,
      });

      const reopened = yield* records.reopen({
        threadId: "thread-1",
        expectedGeneration: 2,
        expectedUpdatedAt: completed.record?.updatedAt,
        commandId: "reopen-1",
      });
      expect(reopened.applied).toBe(true);
      expect(reopened.record).toMatchObject({
        condition: read?.condition,
        outcome: null,
        reason: null,
        uncertain: false,
        settledAt: null,
        generation: 3,
      });

      const duplicate = yield* records.complete({
        threadId: "thread-1",
        outcome: "The pull request merged",
        expectedGeneration: 1,
        commandId: "complete-1",
      });
      expect(duplicate.applied).toBe(false);
      expect(duplicate.record?.generation).toBe(3);

      const staleEpoch = yield* records.complete({
        threadId: "thread-1",
        outcome: "Late completion from the old condition",
        expectedGeneration: 2,
        expectedUpdatedAt: completed.record?.updatedAt,
        commandId: "late-complete",
      });
      expect(staleEpoch.applied).toBe(false);
      expect(staleEpoch.record?.generation).toBe(3);
      expect(staleEpoch.record?.settledAt).toBeNull();

      const staleUpdatedAt = yield* records.complete({
        threadId: "thread-1",
        outcome: "Completion from an old update timestamp",
        expectedGeneration: 3,
        expectedUpdatedAt: "2026-10-15T00:00:00.000Z",
        commandId: "stale-updated-at",
      });
      expect(staleUpdatedAt.applied).toBe(false);
      expect(staleUpdatedAt.record?.generation).toBe(3);

      const earlySettle = yield* records.recordSettle({
        threadId: "thread-1",
        outcome: "No longer needed",
        reason: "dropped",
        uncertain: true,
        expectedGeneration: 3,
        commandId: "settle-1",
      });
      expect(earlySettle.applied).toBe(true);
      expect(earlySettle.record).toMatchObject({
        outcome: "No longer needed",
        reason: "dropped",
        uncertain: true,
        generation: 4,
        settlementHistory: [
          {
            outcome: "No longer needed",
            reason: "dropped",
            uncertain: true,
            generation: 4,
          },
        ],
      });

      const correctedSettle = yield* records.recordSettle({
        threadId: "thread-1",
        outcome: "Still useful after all",
        reason: "done-enough",
        uncertain: false,
        expectedGeneration: 4,
        commandId: "settle-correction-1",
      });
      expect(correctedSettle.applied).toBe(true);
      expect(correctedSettle.record).toMatchObject({
        outcome: "Still useful after all",
        reason: "done-enough",
        generation: 5,
        settlementHistory: [
          { outcome: "No longer needed", reason: "dropped", generation: 4 },
          { outcome: "Still useful after all", reason: "done-enough", generation: 5 },
        ],
      });
      const duplicateCorrection = yield* records.recordSettle({
        threadId: "thread-1",
        outcome: "Still useful after all",
        reason: "done-enough",
        uncertain: false,
        expectedGeneration: 4,
        commandId: "settle-correction-1",
      });
      expect(duplicateCorrection.applied).toBe(false);
      expect(duplicateCorrection.record?.settlementHistory).toHaveLength(2);

      const reopenedAgain = yield* records.reopen({
        threadId: "thread-1",
        expectedGeneration: 5,
        commandId: "reopen-2",
      });
      expect(reopenedAgain.applied).toBe(true);
      expect(reopenedAgain.record).toMatchObject({
        condition: read?.condition,
        generation: 6,
        outcome: null,
        reason: null,
        settledAt: null,
        settlementHistory: correctedSettle.record?.settlementHistory,
      });

      const pending = yield* records.propose({
        threadId: "thread-2",
        summary: "A separate task condition",
        input: { conditions: [{ type: "date.passed", at: "2026-10-18T00:00:00.000Z" }] },
        commandId: "propose-pending",
      });
      const pendingReopened = yield* records.reopen({
        threadId: "thread-2",
        expectedGeneration: 1,
        commandId: "reopen-pending",
      });
      expect(pendingReopened.applied).toBe(true);
      expect(pendingReopened.record).toMatchObject({
        condition: pending.record?.condition,
        generation: 2,
        settledAt: null,
      });
      const stalePendingCompletion = yield* records.complete({
        threadId: "thread-2",
        outcome: "Old condition fired late",
        expectedGeneration: 1,
        commandId: "stale-pending-complete",
      });
      expect(stalePendingCompletion.applied).toBe(false);
      expect(stalePendingCompletion.record?.generation).toBe(2);

      const reopenedWithoutRow = yield* records.reopen({
        threadId: "thread-3",
        expectedGeneration: 0,
        commandId: "reopen-empty",
      });
      expect(reopenedWithoutRow.applied).toBe(true);
      expect(reopenedWithoutRow.record).toMatchObject({
        threadId: "thread-3",
        generation: 1,
        condition: null,
        settledAt: null,
      });
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
