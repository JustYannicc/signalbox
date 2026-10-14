import { describe, expect, it } from "@effect/vitest";
import { projectPool } from "@t3tools/client-runtime/state/sections";
import { ThreadId } from "@t3tools/contracts";
import { FolderId } from "@t3tools/contracts/signalboxFolders";

import { folderHomeOf, folderPoolOf, folderPoolSourceLabel, poolSnapshotFor } from "./folder-pool";
import { DRIVE, PERSONAL_FILES, snapshot } from "./folder-fixtures.test-support";

describe("the pool a thread runs on, with folders", () => {
  it("follows the thread's home, not its project", () => {
    expect(folderHomeOf(snapshot, PERSONAL_FILES, { threadId: ThreadId.make("filed") })).toBe(
      "clients",
    );
    expect(folderPoolOf(snapshot, PERSONAL_FILES, { threadId: ThreadId.make("filed") })).toEqual({
      poolId: "work",
      from: { _tag: "folder", folderId: "work" },
    });
  });

  it("uses the folder a new task starts in, else the project's home", () => {
    expect(folderHomeOf(snapshot, PERSONAL_FILES, { folderId: FolderId.make("notes") })).toBe(
      "notes",
    );
    expect(folderHomeOf(snapshot, DRIVE, undefined)).toBe("northwind");
    expect(folderHomeOf(snapshot, PERSONAL_FILES, undefined)).toBeNull();
    expect(folderPoolOf(snapshot, null, { folderId: FolderId.make("ops") })).toBeNull();
  });

  it("hands the shared pool helpers that pool", () => {
    const pool = folderPoolOf(snapshot, PERSONAL_FILES, { folderId: FolderId.make("clients") });
    expect(projectPool(poolSnapshotFor(pool), null)?.poolId).toBe("work");
    expect(projectPool(poolSnapshotFor(null), null)).toBeNull();
  });

  it("says where the pool comes from", () => {
    const clients = folderPoolOf(snapshot, null, { folderId: FolderId.make("clients") });
    expect(folderPoolSourceLabel(snapshot, clients, "Work")).toBe("Runs on Work · from Work");
    const notes = folderPoolOf(snapshot, null, { folderId: FolderId.make("notes") });
    expect(folderPoolSourceLabel(snapshot, notes, undefined)).toBe(
      "Runs on its pool · from the top level",
    );
    expect(folderPoolSourceLabel(snapshot, null, "Work")).toBe("Needs a pool");
  });
});
