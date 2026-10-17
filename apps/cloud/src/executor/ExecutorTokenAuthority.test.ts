import { describe, expect, it } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";

import { executorFolderLevelMatches, executorTurnIsCurrent } from "./ExecutorTokenAuthority.ts";

describe("Executor token live authority", () => {
  it("keeps folder tokens inside the exact current organization folder", () => {
    const claims = { owner: "org_acme", level: "folder_1" };
    const source = { _tag: "folder", folderId: FolderId.make("folder_1") } as const;

    expect(
      executorFolderLevelMatches(claims, source, {
        id: "folder_1",
        ownerId: "org_acme",
      }),
    ).toBe(true);
    expect(
      executorFolderLevelMatches(claims, source, {
        id: "folder_1",
        ownerId: "org_other",
      }),
    ).toBe(false);
    expect(
      executorFolderLevelMatches(
        { owner: "org_acme", level: "org_acme" },
        { _tag: "person" },
        undefined,
      ),
    ).toBe(false);
    expect(
      executorFolderLevelMatches(
        claims,
        { _tag: "folder", folderId: FolderId.make("folder_elsewhere") },
        { id: "folder_elsewhere", ownerId: "org_acme" },
      ),
    ).toBe(false);
  });

  it("requires the exact live run in the thread's current context and level", () => {
    const claims = { owner: "org_acme", level: "folder_1", turn: "run_current" };
    const live = {
      contextId: "org_acme",
      level: "folder_1",
      activeRunId: "run_current",
    };

    expect(executorTurnIsCurrent(claims, live)).toBe(true);
    expect(executorTurnIsCurrent(claims, { ...live, activeRunId: "run_stopped" })).toBe(false);
    expect(executorTurnIsCurrent(claims, { ...live, level: "folder_elsewhere" })).toBe(false);
    expect(executorTurnIsCurrent(claims, { ...live, contextId: "org_other" })).toBe(false);
  });
});
