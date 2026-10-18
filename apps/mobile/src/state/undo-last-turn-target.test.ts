import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";

import { resolveUndoLastTurnTarget } from "./undo-last-turn-target";

type Status = OrchestrationV2ThreadProjection["runs"][number]["status"];

function run(ordinal: number, status: Status = "completed") {
  return {
    id: `run-${ordinal}`,
    ordinal,
    status,
    userMessageId: `message-${ordinal}`,
    providerInstanceId: "codex",
    checkpointId: `checkpoint-${ordinal}`,
    requestedAt: DateTime.makeUnsafe("2026-10-18T10:00:00Z"),
    startedAt: null,
    completedAt: null,
  };
}

function checkpoint(ordinal: number, files: ReadonlyArray<unknown> = []) {
  return {
    id: `checkpoint-${ordinal}`,
    runId: `run-${ordinal}`,
    scopeId: `scope-${ordinal}`,
    ordinalWithinScope: 1,
    appRunOrdinal: ordinal,
    status: "ready",
    files,
  };
}

const baseline = {
  id: "checkpoint-baseline",
  runId: "run-1",
  scopeId: "scope-1",
  ordinalWithinScope: 0,
  appRunOrdinal: null,
  status: "ready",
  files: [],
};

function projection(input: {
  readonly runs: ReadonlyArray<
    ReturnType<typeof run> & { readonly restartContinuationOfRunId?: string }
  >;
  readonly checkpoints: ReadonlyArray<unknown>;
}) {
  return {
    thread: {},
    runs: input.runs,
    checkpoints: input.checkpoints,
    checkpointScopes: [1, 2, 3].map((ordinal) => ({
      id: `scope-${ordinal}`,
      kind: "root_run",
    })),
  } as unknown as OrchestrationV2ThreadProjection;
}

describe("resolveUndoLastTurnTarget", () => {
  it("undoes the last turn back to the end of the turn before it", () => {
    expect(
      resolveUndoLastTurnTarget(
        projection({
          runs: [run(1), run(2)],
          checkpoints: [baseline, checkpoint(1), checkpoint(2, [{ path: "a.ts" }])],
        }),
      ),
    ).toEqual({
      userMessageId: "message-2",
      providerInstanceId: "codex",
      scopeId: "scope-1",
      checkpointId: "checkpoint-1",
      changedFiles: true,
    });
  });

  it("undoes the first turn back to the thread's baseline", () => {
    expect(
      resolveUndoLastTurnTarget(
        projection({ runs: [run(1)], checkpoints: [baseline, checkpoint(1)] }),
      ),
    ).toMatchObject({
      userMessageId: "message-1",
      checkpointId: "checkpoint-baseline",
      changedFiles: false,
    });
  });

  it("skips turns that were already undone", () => {
    expect(
      resolveUndoLastTurnTarget(
        projection({
          runs: [run(1), run(2, "rolled_back"), run(3)],
          checkpoints: [baseline, checkpoint(1), checkpoint(2), checkpoint(3)],
        }),
      ),
    ).toMatchObject({ userMessageId: "message-3", checkpointId: "checkpoint-1" });
  });

  it("offers nothing while a turn runs or waits in the queue", () => {
    for (const status of ["running", "queued", "waiting"] as const) {
      expect(
        resolveUndoLastTurnTarget(
          projection({ runs: [run(1), run(2, status)], checkpoints: [baseline, checkpoint(1)] }),
        ),
      ).toBeNull();
    }
  });

  it("undoes a heavy continuation through its original user turn", () => {
    expect(
      resolveUndoLastTurnTarget(
        projection({
          runs: [run(1), run(2, "interrupted"), { ...run(3), restartContinuationOfRunId: "run-2" }],
          checkpoints: [baseline, checkpoint(1), checkpoint(2, [{ path: "a.ts" }]), checkpoint(3)],
        }),
      ),
    ).toMatchObject({
      userMessageId: "message-2",
      checkpointId: "checkpoint-1",
      changedFiles: true,
    });
  });

  it("undoes chained continuations of the first turn to the baseline", () => {
    expect(
      resolveUndoLastTurnTarget(
        projection({
          runs: [
            run(1, "interrupted"),
            { ...run(2, "interrupted"), restartContinuationOfRunId: "run-1" },
            { ...run(3), restartContinuationOfRunId: "run-2" },
          ],
          checkpoints: [baseline, checkpoint(1), checkpoint(2), checkpoint(3)],
        }),
      ),
    ).toMatchObject({
      userMessageId: "message-1",
      checkpointId: "checkpoint-baseline",
      changedFiles: false,
    });
  });

  it("offers nothing when the continuation's root is missing", () => {
    expect(
      resolveUndoLastTurnTarget(
        projection({
          runs: [run(1), { ...run(3), restartContinuationOfRunId: "run-2" }],
          checkpoints: [baseline, checkpoint(1), checkpoint(3)],
        }),
      ),
    ).toBeNull();
  });

  it("offers nothing for cyclic continuation links", () => {
    expect(
      resolveUndoLastTurnTarget(
        projection({
          runs: [
            { ...run(1), restartContinuationOfRunId: "run-2" },
            { ...run(2), restartContinuationOfRunId: "run-1" },
          ],
          checkpoints: [baseline, checkpoint(1), checkpoint(2)],
        }),
      ),
    ).toBeNull();
  });

  it("offers nothing when paged history hides the turn before", () => {
    expect(
      resolveUndoLastTurnTarget(projection({ runs: [run(3)], checkpoints: [checkpoint(3)] })),
    ).toBeNull();
  });
});
