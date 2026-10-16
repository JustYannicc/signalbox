import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  type OrchestrationV2Checkpoint,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { latestSkippedFolders } from "./skippedFolders.logic";

const nodeModules = { path: "node_modules", recipe: "pnpm install --frozen-lockfile" };
const cache = { path: "~/.cache", recipe: "A cache: tools fill it again as they need it" };

function checkpoint(
  appRunOrdinal: number | null,
  skipped?: OrchestrationV2Checkpoint["skipped"],
): OrchestrationV2Checkpoint {
  return {
    id: CheckpointId.make(`checkpoint-${appRunOrdinal}`),
    threadId: ThreadId.make("thread-1"),
    scopeId: CheckpointScopeId.make("scope-1"),
    runId: null,
    nodeId: NodeId.make("node-root"),
    parentCheckpointId: null,
    ordinalWithinScope: appRunOrdinal ?? 0,
    appRunOrdinal,
    ref: CheckpointRef.make(`refs/checkpoint-${appRunOrdinal}`),
    status: "ready",
    files: [],
    capturedAt: DateTime.makeUnsafe("2026-10-15T12:00:00.000Z"),
    ...(skipped === undefined ? {} : { skipped }),
  };
}

describe("latestSkippedFolders", () => {
  it("says nothing for threads whose checkpoints never record a machine", () => {
    expect(latestSkippedFolders([])).toBeNull();
    expect(latestSkippedFolders([checkpoint(1), checkpoint(2)])).toBeNull();
  });

  it("reads the latest turn that recorded skipped folders, whatever the projection order", () => {
    const latest = [nodeModules, cache];
    expect(
      latestSkippedFolders([checkpoint(3, latest), checkpoint(1, [nodeModules]), checkpoint(4)]),
    ).toBe(latest);
  });

  it("says nothing once the latest turn left nothing out", () => {
    expect(latestSkippedFolders([checkpoint(1, [nodeModules]), checkpoint(2, [])])).toBeNull();
  });
});
