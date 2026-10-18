import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { toggleRunFoldExpansion, transitionRunFoldExpansion } from "./threadFoldExpansion.ts";

describe("thread fold expansion state", () => {
  it("keeps a stopped continuation fold collapsible, reopenable, and clearable on the next run", () => {
    const rootRunId = RunId.make("root");
    const continuationRunId = RunId.make("continuation");
    const nextRunId = RunId.make("next");
    const continuations = new Map<RunId, { readonly rootRunId: RunId }>([
      [rootRunId, { rootRunId }],
      [continuationRunId, { rootRunId }],
    ]);

    const autoExpanded = transitionRunFoldExpansion(
      new Set([continuationRunId]),
      { runId: continuationRunId, status: "running" },
      { runId: continuationRunId, status: "interrupted" },
      continuations,
    );
    expect(autoExpanded).toEqual(new Set([rootRunId]));

    const collapsed = toggleRunFoldExpansion(autoExpanded, rootRunId, continuations);
    expect(collapsed).toEqual(new Set());

    const reopened = toggleRunFoldExpansion(collapsed, rootRunId, continuations);
    expect(reopened).toEqual(new Set([rootRunId]));

    const collapsedFromRetainedPhysicalId = toggleRunFoldExpansion(
      new Set([continuationRunId]),
      rootRunId,
      continuations,
    );
    expect(collapsedFromRetainedPhysicalId).toEqual(new Set());

    const clearedForNextRun = transitionRunFoldExpansion(
      new Set([continuationRunId]),
      { runId: continuationRunId, status: "interrupted" },
      { runId: nextRunId, status: "running" },
      continuations,
    );
    expect(clearedForNextRun).toEqual(new Set());
  });
});
