import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  clientRpcRequiredScopes,
} from "@t3tools/contracts";
import {
  SIGNALBOX_TRASH_REQUIRED_SCOPES,
  SIGNALBOX_TRASH_WS_METHODS,
  TrashEntry,
  TrashPlannedRemoval,
  TRASH_RETENTION_DAYS,
} from "./signalboxTrash.ts";

const decodeEntry = Schema.decodeUnknownSync(TrashEntry);
const decodePlannedRemoval = Schema.decodeUnknownSync(TrashPlannedRemoval);

describe("Signalbox Trash contract", () => {
  it("accepts each lifecycle state with numeric retention timestamps", () => {
    const entry = {
      id: "trash-1",
      kind: "thread",
      targetId: "thread-1",
      title: "A task",
      deletedAt: 1_000,
      purgeAfter: 1_000 + TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
      threadIds: ["thread-1"],
      removals: [{ kind: "file", id: "src/main.ts" }],
      error: null,
    };

    for (const status of ["trashed", "restoring", "purging", "purged", "restored"] as const) {
      expect(decodeEntry({ ...entry, status }).status).toBe(status);
    }
    expect(() => decodeEntry({ ...entry, status: "deleted" })).toThrow();
  });

  it("keeps planned scopes separate and optional for existing clients", () => {
    const entry = {
      id: "trash-1",
      kind: "folder",
      targetId: "folder-1",
      title: "Work",
      deletedAt: 1_000,
      purgeAfter: 2_000,
      status: "trashed",
      threadIds: ["thread-1"],
      removals: [],
      error: null,
    };

    expect(decodeEntry(entry).plannedRemovals).toBeUndefined();
    const planned = [
      { _tag: "threadResource", threadId: "thread-1", resource: "history" },
      { _tag: "driveThreadRefs", driveId: "folder/personal/drive-1", threadId: "thread-1" },
      { _tag: "folder", folderId: "folder-1" },
      { _tag: "note", noteId: "note-1" },
      { _tag: "drive", driveId: "folder/personal/drive-1", onlyIfUnshared: true },
    ] as const;
    expect(planned.map((item) => decodePlannedRemoval(item))).toEqual(planned);
    expect(decodeEntry({ ...entry, plannedRemovals: planned, removals: [] })).toMatchObject({
      plannedRemovals: planned,
      removals: [],
    });
  });

  it("requires read scope to list and operate scope to change Trash", () => {
    expect(SIGNALBOX_TRASH_REQUIRED_SCOPES[SIGNALBOX_TRASH_WS_METHODS.list]).toBe(
      AuthOrchestrationReadScope,
    );
    for (const method of [
      SIGNALBOX_TRASH_WS_METHODS.restore,
      SIGNALBOX_TRASH_WS_METHODS.empty,
      SIGNALBOX_TRASH_WS_METHODS.thread,
      SIGNALBOX_TRASH_WS_METHODS.folder,
    ]) {
      expect(SIGNALBOX_TRASH_REQUIRED_SCOPES[method]).toBe(AuthOrchestrationOperateScope);
      expect(clientRpcRequiredScopes(method, {})).toEqual([AuthOrchestrationOperateScope]);
    }
  });
});
