import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadHomeLookup } from "@t3tools/client-runtime/state/signalboxFolders";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  SignalboxContextId,
  type SignalboxContextsSnapshot,
} from "@t3tools/contracts/signalboxContexts";
import {
  type Folder,
  FolderId,
  type SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "vite-plus/test";

import {
  folderNodeKey,
  folderOwnerKey,
  folderOwners,
  folderThreadCounts,
  folderThreadListKey,
  movedThreadDestination,
  moveThreadMenuItem,
  threadsByHome,
  visibleFolderThreadKeys,
  type FolderThread,
} from "./folderSidebarModel";

const ENV = EnvironmentId.make("cloud");
const PERSONAL = SignalboxContextId.make("personal");
const ACME = SignalboxContextId.make("org_acme");
const SCRATCH = ProjectId.make("scratch");
const NORTHWIND_DRIVE = ProjectId.make("drive:shared/acme/northwind");
const ACME_FILES = ProjectId.make("context:org_acme");

const folder = (
  id: string,
  parentId: string | null,
  position: number,
  extra: Partial<Folder> = {},
): Folder => ({
  id: FolderId.make(id),
  name: id[0]!.toUpperCase() + id.slice(1),
  parentId: parentId === null ? null : FolderId.make(parentId),
  position,
  ownerId: PERSONAL,
  ...extra,
});

const contexts: SignalboxContextsSnapshot = {
  contexts: [
    { id: PERSONAL, kind: "personal", name: "Personal", projectIds: [SCRATCH] },
    { id: ACME, kind: "organization", name: "Acme", projectIds: [ACME_FILES, NORTHWIND_DRIVE] },
  ],
};

/** Personal: Work › Clients, and Notes. Acme: Northwind with its drive. */
const snapshot: SignalboxFoldersSnapshot = {
  revision: 1,
  top: {},
  folders: [
    folder("work", null, 0),
    folder("clients", "work", 0),
    folder("notes", null, 1),
    folder("northwind", null, 0, { ownerId: ACME, files: { projectId: NORTHWIND_DRIVE } }),
  ],
  threadHomes: [
    { threadId: ThreadId.make("filed-in-clients"), folderId: FolderId.make("clients") },
    { threadId: ThreadId.make("filed-at-top"), folderId: null },
  ],
  projectHomes: [
    { projectId: SCRATCH, folderId: null },
    { projectId: NORTHWIND_DRIVE, folderId: FolderId.make("northwind") },
  ],
  pools: { top: null, folders: [] },
};

const thread = (
  id: string,
  projectId: ProjectId,
  updatedAt: string,
  archivedAt: string | null = null,
): FolderThread => ({
  id: ThreadId.make(id),
  environmentId: ENV,
  projectId,
  archivedAt,
  createdAt: updatedAt,
  updatedAt,
  latestUserMessageAt: updatedAt,
});

const threads = [
  thread("loose", SCRATCH, "2026-10-01T10:00:00Z"),
  thread("loose-newer", SCRATCH, "2026-10-02T10:00:00Z"),
  thread("archived", SCRATCH, "2026-10-03T10:00:00Z", "2026-10-04T10:00:00Z"),
  thread("filed-in-clients", SCRATCH, "2026-10-01T09:00:00Z"),
  thread("in-northwind", NORTHWIND_DRIVE, "2026-10-01T08:00:00Z"),
  thread("filed-at-top", NORTHWIND_DRIVE, "2026-10-01T07:00:00Z"),
];

const key = (id: string) => scopedThreadKey(scopeThreadRef(ENV, ThreadId.make(id)));

const owners = folderOwners(contexts, snapshot);
const homeOf = threadHomeLookup(snapshot);
const environment = {
  environmentId: ENV,
  owners: owners.map((owner) => ({
    ...owner,
    threadsByHome: threadsByHome(homeOf, owner, threads),
  })),
};

describe("folderSidebarModel", () => {
  it("lists owners Personal first, each with its own files and its own tree", () => {
    expect(owners.map((owner) => owner.context.name)).toEqual(["Personal", "Acme"]);
    expect(owners.map((owner) => owner.filesProjectId)).toEqual([SCRATCH, ACME_FILES]);
    expect(owners[0]!.roots.map((node) => node.folder.name)).toEqual(["Work", "Notes"]);
    expect(owners[1]!.roots.map((node) => node.folder.name)).toEqual(["Northwind"]);
  });

  it("puts each live thread at its home, within its owner's tree only", () => {
    const personal = threadsByHome(homeOf, owners[0]!, threads);
    expect(personal.get(null)?.map((entry) => entry.id)).toEqual(["loose", "loose-newer"]);
    expect(personal.get(FolderId.make("clients"))?.map((entry) => entry.id)).toEqual([
      "filed-in-clients",
    ]);
    const acme = threadsByHome(homeOf, owners[1]!, threads);
    expect(acme.get(FolderId.make("northwind"))?.map((entry) => entry.id)).toEqual([
      "in-northwind",
    ]);
    expect(acme.get(null)?.map((entry) => entry.id)).toEqual(["filed-at-top"]);
  });

  it("counts the threads in a folder and everywhere below it", () => {
    const counts = folderThreadCounts(owners[0]!.roots, threadsByHome(homeOf, owners[0]!, threads));
    expect(counts.get(FolderId.make("work"))).toBe(1);
    expect(counts.get(FolderId.make("clients"))).toBe(1);
    expect(counts.get(FolderId.make("notes"))).toBe(0);
  });

  it("orders visible threads as drawn: top level, then open folders, honoring Show more", () => {
    const visible = (input: {
      collapsed?: ReadonlyArray<string>;
      previewCount?: number;
      expanded?: ReadonlyArray<string>;
    }) =>
      visibleFolderThreadKeys({
        environments: [environment],
        collapsed: new Set(input.collapsed ?? []),
        threadSortOrder: "updated_at",
        threadPreviewCount: input.previewCount ?? 10,
        expandedThreadLists: new Set(input.expanded ?? []),
      });
    expect(visible({})).toEqual([
      key("loose-newer"),
      key("loose"),
      key("filed-in-clients"),
      key("filed-at-top"),
      key("in-northwind"),
    ]);
    expect(
      visible({
        collapsed: [folderNodeKey(ENV, FolderId.make("work")), folderOwnerKey(ENV, ACME)],
      }),
    ).toEqual([key("loose-newer"), key("loose")]);
    const topList = folderThreadListKey(ENV, PERSONAL, null);
    expect(visible({ previewCount: 1 }).slice(0, 2)).toEqual([
      key("loose-newer"),
      key("filed-in-clients"),
    ]);
    expect(visible({ previewCount: 1, expanded: [topList] }).slice(0, 2)).toEqual([
      key("loose-newer"),
      key("loose"),
    ]);
  });

  it("offers a thread every other place in its owner's tree, and reads the choice back", () => {
    const menu = moveThreadMenuItem(snapshot, PERSONAL, FolderId.make("clients"));
    expect(menu.children?.map((item) => [item.label, item.disabled])).toEqual([
      ["Top level", false],
      ["Work", false],
      ["Work / Clients", true],
      ["Notes", false],
    ]);
    const [top, work] = menu.children!;
    expect(movedThreadDestination(top!.id)).toEqual({ folderId: null });
    expect(movedThreadDestination(work!.id)).toEqual({ folderId: "work" });
    expect(movedThreadDestination(menu.id)).toBeNull();
    expect(movedThreadDestination("rename")).toBeNull();
    expect(movedThreadDestination(null)).toBeNull();
  });
});
