import type { ThreadStatusState } from "@t3tools/client-runtime/state/threadStatusLine";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId, type SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "vite-plus/test";

import {
  folderStatusBreakdown,
  folderStatusCountsByNode,
  type FolderStatusResident,
} from "./folderStatus";
import { folderNodeKey, folderOwners } from "./folderSidebarModel";

const ENV = EnvironmentId.make("cloud");
const PERSONAL = SignalboxContextId.make("personal");
const SCRATCH = ProjectId.make("scratch");
const ELSEWHERE = ProjectId.make("not-an-owners");

const folder = (id: string, parentId: string | null) => ({
  id: FolderId.make(id),
  name: id,
  parentId: parentId === null ? null : FolderId.make(parentId),
  position: 0,
  ownerId: PERSONAL,
});

/** Work › Clients, and Notes. */
const snapshot: SignalboxFoldersSnapshot = {
  revision: 1,
  top: {},
  folders: [folder("work", null), folder("clients", "work"), folder("notes", null)],
  threadHomes: [
    { threadId: ThreadId.make("building"), folderId: FolderId.make("clients") },
    { threadId: ThreadId.make("asking"), folderId: FolderId.make("clients") },
    { threadId: ThreadId.make("resting"), folderId: FolderId.make("work") },
    { threadId: ThreadId.make("jotting"), folderId: FolderId.make("notes") },
    { threadId: ThreadId.make("foreign"), folderId: FolderId.make("clients") },
  ],
  projectHomes: [{ projectId: SCRATCH, folderId: null }],
  pools: { top: null, folders: [] },
};

const owners = folderOwners(
  { contexts: [{ id: PERSONAL, kind: "personal", name: "Personal", projectIds: [SCRATCH] }] },
  snapshot,
);
const trees = [{ environmentId: ENV, snapshot, owners }];

const resident = (
  id: string,
  state: ThreadStatusState,
  projectId: ProjectId = SCRATCH,
): FolderStatusResident => ({
  environmentId: ENV,
  id: ThreadId.make(id),
  projectId,
  state,
  updatedAt: "2026-10-16T10:00:00Z",
});

const residents = [
  resident("building", "working"),
  resident("asking", "waiting_on_person"),
  resident("resting", "idle"),
  resident("jotting", "idle"),
  resident("foreign", "working", ELSEWHERE),
];

const node = (id: string) => folderNodeKey(ENV, FolderId.make(id));

describe("folderStatusCountsByNode", () => {
  it("counts each folder and everything below it, owners' threads only", () => {
    const counts = folderStatusCountsByNode(trees, residents, undefined);
    expect(counts.get(node("clients"))).toEqual({ working: 1, waiting: 1, idle: 0 });
    expect(counts.get(node("work"))).toEqual({ working: 1, waiting: 1, idle: 1 });
    expect(counts.get(node("notes"))).toEqual({ working: 0, waiting: 0, idle: 1 });
  });

  it("keeps the counts of folders that didn't change, so only those rows redraw", () => {
    const before = folderStatusCountsByNode(trees, residents, undefined);
    expect(folderStatusCountsByNode(trees, residents, before)).toBe(before);

    const after = folderStatusCountsByNode(
      trees,
      residents.map((thread) =>
        thread.id === ThreadId.make("asking") ? { ...thread, state: "working" as const } : thread,
      ),
      before,
    );
    expect(after).not.toBe(before);
    expect(after.get(node("clients"))).toEqual({ working: 2, waiting: 0, idle: 0 });
    expect(after.get(node("notes"))).toBe(before.get(node("notes")));
  });
});

describe("folderStatusBreakdown", () => {
  it("says everything, idle included, and leaves out what's zero", () => {
    expect(folderStatusBreakdown({ working: 2, waiting: 1, idle: 4 })).toBe(
      "2 working · 1 waiting · 4 idle",
    );
    expect(folderStatusBreakdown({ working: 0, waiting: 0, idle: 3 })).toBe("3 idle");
  });
});
