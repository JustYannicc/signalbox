import { describe, expect, it } from "@effect/vitest";
import { RunId, type OrchestrationV2Run } from "@t3tools/contracts";
import { runContinuationChain, runOrigin } from "../thread/runContinuations.ts";

import { hasPendingTaskRuns, latestTaskTerminalRun } from "./taskRuns.ts";

type Run = Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "restartContinuationOfRunId">;

const run = (
  id: string,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  continuationOf?: string,
): Run => ({
  id: RunId.make(id),
  ordinal,
  status,
  ...(continuationOf === undefined
    ? {}
    : { restartContinuationOfRunId: RunId.make(continuationOf) }),
});

describe("task run recovery", () => {
  it("follows the original run through multiple continuations regardless of projection order", () => {
    const original = run("run:1", 1, "interrupted");
    const firstRecovery = run("run:2", 2, "interrupted", original.id);
    const secondRecovery = run("run:3", 3, "running", firstRecovery.id);
    const unrelated = run("run:4", 4, "completed");
    const runs = [secondRecovery, unrelated, original, firstRecovery];

    expect(runContinuationChain(runs, original).map((candidate) => candidate.id)).toEqual([
      original.id,
      firstRecovery.id,
      secondRecovery.id,
    ]);
    expect(runContinuationChain(runs, original.id).at(-1)?.id).toBe(secondRecovery.id);
    expect(runOrigin(runs, secondRecovery.id)?.id).toBe(original.id);
  });

  it("keeps a recovery on its original ordinal across an unrelated queued run", () => {
    const original = run("run:1", 1, "interrupted");
    const queued = run("run:2", 2, "queued");
    const recovery = run("run:3", 3, "running", original.id);
    const runs = [queued, recovery, original];

    expect(runOrigin(runs, recovery)?.ordinal).toBe(original.ordinal);
    expect(runContinuationChain(runs, original).map((candidate) => candidate.id)).toEqual([
      original.id,
      recovery.id,
    ]);
    expect(hasPendingTaskRuns(runs, original)).toBe(true);
  });

  it("returns the original alone and returns an empty chain for a missing run", () => {
    const original = run("run:1", 1, "completed");

    expect(runContinuationChain([original], original.id)).toEqual([original]);
    expect(runContinuationChain([original], RunId.make("run:missing"))).toEqual([]);
  });

  it("resolves malformed branches by ordinal and never loops through a cycle", () => {
    const original = run("run:1", 1, "interrupted", "run:2");
    const earlierBranch = run("run:2", 2, "interrupted", original.id);
    const laterBranch = run("run:3", 3, "running", original.id);

    const runs = [laterBranch, original, earlierBranch];
    expect(runContinuationChain(runs, original).map((candidate) => candidate.id)).toEqual([
      original.id,
      earlierBranch.id,
    ]);
    expect(runOrigin(runs, earlierBranch)?.id).toBe(original.id);
  });

  it("does not report an interrupted recovery predecessor as the latest terminal run", () => {
    const previousTask = run("run:1", 1, "completed");
    const interrupted = run("run:2", 2, "interrupted");
    const recovery = run("run:3", 3, "running", interrupted.id);

    expect(latestTaskTerminalRun([previousTask, interrupted, recovery])?.id).toBe(previousTask.id);
    expect(hasPendingTaskRuns([interrupted, recovery], interrupted)).toBe(false);
    expect(
      hasPendingTaskRuns([interrupted, recovery, run("run:4", 4, "queued")], interrupted),
    ).toBe(true);

    const completedRecovery = { ...recovery, status: "completed" as const };
    expect(latestTaskTerminalRun([previousTask, interrupted, completedRecovery])?.id).toBe(
      completedRecovery.id,
    );
  });
});
