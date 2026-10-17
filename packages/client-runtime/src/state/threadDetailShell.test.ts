import { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection, v2Now } from "@t3tools/client-runtime/testing/orchestration-v2";
import { threadDetailToShell } from "@t3tools/client-runtime/state/thread-detail-shell";

describe("threadDetailToShell", () => {
  it("preserves archived state when presenting a detail projection as a shell", () => {
    const archivedAt = DateTime.makeUnsafe("2026-10-16T12:00:00.000Z");
    const projection = {
      ...v2Projection,
      thread: { ...v2Projection.thread, archivedAt },
    };

    const shell = threadDetailToShell(EnvironmentId.make("environment-1"), projection);

    expect(shell.archivedAt).toBe(DateTime.formatIso(archivedAt));
    expect(shell.source.archivedAt).toBe(archivedAt);
    expect(projection.thread.archivedAt).toBe(archivedAt);
    expect(shell.createdAt).toBe(DateTime.formatIso(v2Now));
  });
});
