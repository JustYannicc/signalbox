import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";

import { folderPoolSourceLabel, poolOfPoolHome } from "./folder-pool";
import { DRIVE, PERSONAL_FILES, snapshot } from "./folder-fixtures.test-support";

describe("the pool a thread runs on, with folders", () => {
  it("follows the thread's home, not its project", () => {
    expect(poolOfPoolHome(snapshot, PERSONAL_FILES, { threadId: ThreadId.make("filed") })).toEqual({
      poolId: "work",
      from: { _tag: "folder", folderId: "work" },
    });
  });

  it("uses the folder a new task starts in, else the project's home", () => {
    expect(poolOfPoolHome(snapshot, PERSONAL_FILES, { folderId: FolderId.make("ops") })).toBeNull();
    expect(poolOfPoolHome(snapshot, PERSONAL_FILES, { folderId: null })?.poolId).toBe("personal");
    expect(poolOfPoolHome(snapshot, DRIVE, undefined)?.poolId).toBe("work");
  });

  it("says where the pool comes from", () => {
    const clients = poolOfPoolHome(snapshot, null, { folderId: FolderId.make("clients") });
    expect(folderPoolSourceLabel(snapshot, clients, "Work")).toBe("Runs on Work · from Work");
    const notes = poolOfPoolHome(snapshot, null, { folderId: FolderId.make("notes") });
    expect(folderPoolSourceLabel(snapshot, notes, undefined)).toBe(
      "Runs on its pool · from the top level",
    );
    expect(folderPoolSourceLabel(snapshot, null, "Work")).toBe("Needs a pool");
  });
});
