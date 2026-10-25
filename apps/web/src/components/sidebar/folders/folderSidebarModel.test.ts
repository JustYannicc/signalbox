import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadFolderChoices,
  threadHomeLookup,
} from "@t3tools/client-runtime/state/signalboxFolders";
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
  folderListOfThreads,
  folderNodeKey,
  folderOwnerKey,
  folderOwners,
  recentlySettledFolderThreads,
  folderThreadListKey,
  movedThreadDestination,
  moveThreadMenuItem,
  sameResidents,
  sliceFolderThreads,
  visibleFolderLists,
  type FolderResident,
} from "./folderSidebarModel";

const ENV = EnvironmentId.make("cloud");
const PERSONAL = SignalboxContextId.make("personal");
const ACME = SignalboxContextId.make("org_acme");
const SCRATCH = ProjectId.make("scratch");
const NORTHWIND_DRIVE = ProjectId.make("drive:shared/acme/northwind");
const ACME_FILES = ProjectId.make("context:org_acme");
const ELSEWHERE = ProjectId.make("not-an-owners");

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

const resident = (
  id: string,
  projectId: ProjectId,
  archivedAt: string | null = null,
): FolderResident => ({ environmentId: ENV, id: ThreadId.make(id), projectId, archivedAt });

const residents = [
  resident("loose", SCRATCH),
  resident("archived", SCRATCH, "2026-10-04T10:00:00Z"),
  resident("filed-in-clients", SCRATCH),
  resident("in-northwind", NORTHWIND_DRIVE),
  resident("filed-at-top", NORTHWIND_DRIVE),
  resident("no-owner", ELSEWHERE),
];

const key = (id: string) => scopedThreadKey(scopeThreadRef(ENV, ThreadId.make(id)));
const owners = folderOwners(contexts, snapshot);
const listOf = folderListOfThreads(ENV, owners, threadHomeLookup(snapshot), residents);

describe("folderSidebarModel", () => {
  it("lists owners Personal first, each with its own files and its own tree", () => {
    expect(owners.map((owner) => owner.context.name)).toEqual(["Personal", "Acme"]);
    expect(owners.map((owner) => owner.filesProjectId)).toEqual([SCRATCH, ACME_FILES]);
    expect(owners[0]!.roots.map((node) => node.folder.name)).toEqual(["Work", "Notes"]);
  });

  it("shows each live thread in its owner's list for its home, and others nowhere", () => {
    expect(Object.fromEntries(listOf)).toEqual({
      [key("loose")]: folderThreadListKey(ENV, PERSONAL, null),
      [key("filed-in-clients")]: folderThreadListKey(ENV, PERSONAL, FolderId.make("clients")),
      [key("in-northwind")]: folderThreadListKey(ENV, ACME, FolderId.make("northwind")),
      [key("filed-at-top")]: folderThreadListKey(ENV, ACME, null),
    });
  });

  it("keeps settled tasks in each folder after they are archived, excluding chat archives", () => {
    const candidate = (
      id: string,
      projectId: ProjectId,
      fields: Partial<{
        readonly archivedAt: string | null;
        readonly settledAt: string | null;
        readonly settledOverride: "settled" | "active" | null;
        readonly kind: "task" | "chat";
      }> = {},
    ) => ({
      environmentId: ENV,
      id: ThreadId.make(id),
      projectId,
      title: id,
      updatedAt: "2026-10-01T00:00:00.000Z",
      archivedAt: fields.archivedAt ?? null,
      settledAt: fields.settledAt ?? null,
      settledOverride: fields.settledOverride ?? null,
      kind: fields.kind ?? "task",
    });
    const clients = FolderId.make("clients");
    const clientHomeSnapshot: SignalboxFoldersSnapshot = {
      ...snapshot,
      threadHomes: [
        ...snapshot.threadHomes,
        { threadId: ThreadId.make("settled-live"), folderId: clients },
        { threadId: ThreadId.make("settled-live-at"), folderId: clients },
        { threadId: ThreadId.make("completed"), folderId: clients },
        { threadId: ThreadId.make("archived-override"), folderId: clients },
        { threadId: ThreadId.make("archived-chat"), folderId: clients },
      ],
    };
    const recent = recentlySettledFolderThreads({
      environmentId: ENV,
      projectIds: [SCRATCH],
      home: clients,
      homeOf: threadHomeLookup(clientHomeSnapshot),
      liveThreads: [
        candidate("settled-live", SCRATCH, { settledOverride: "settled" }),
        candidate("settled-live-at", SCRATCH, {
          settledAt: "2026-10-07T00:00:00.000Z",
        }),
        candidate("other-folder", SCRATCH, {
          settledOverride: "settled",
        }),
      ],
      archivedThreads: [
        candidate("completed", SCRATCH, {
          archivedAt: "2026-10-05T00:00:00.000Z",
          settledAt: "2026-10-05T00:00:00.000Z",
        }),
        candidate("archived-override", SCRATCH, {
          archivedAt: "2026-10-06T00:00:00.000Z",
          settledOverride: "settled",
        }),
        candidate("archived-chat", SCRATCH, {
          archivedAt: "2026-10-06T00:00:00.000Z",
          settledOverride: "settled",
          kind: "chat",
        }),
      ],
      isTask: (thread) => thread.kind === "task",
    });
    expect(recent.map((thread) => thread.id)).toEqual([
      "settled-live-at",
      "archived-override",
      "completed",
      "settled-live",
    ]);
  });

  it("keeps a list's array, and the whole map, while its threads stay the same objects", () => {
    const threads = residents.map((entry) => ({ ...entry }));
    const first = sliceFolderThreads(threads, listOf, undefined);
    expect(first.get(folderThreadListKey(ENV, PERSONAL, null))?.map((entry) => entry.id)).toEqual([
      "loose",
    ]);
    expect(sliceFolderThreads(threads, listOf, first)).toBe(first);
    const renamed = threads.map((entry) => (entry.id === "loose" ? { ...entry } : entry));
    const second = sliceFolderThreads(renamed, listOf, first);
    expect(second).not.toBe(first);
    const clients = folderThreadListKey(ENV, PERSONAL, FolderId.make("clients"));
    expect(second.get(clients)).toBe(first.get(clients));
  });

  it("tells residents apart only by what decides where they show", () => {
    expect(
      sameResidents(
        residents,
        residents.map((entry) => ({ ...entry })),
      ),
    ).toBe(true);
    expect(
      sameResidents(
        residents,
        residents.map((entry) =>
          entry.id === "loose" ? { ...entry, archivedAt: "2026-10-05T00:00:00Z" } : entry,
        ),
      ),
    ).toBe(false);
  });

  it("orders the open lists as drawn: top level, then each open folder's subfolders, then its own", () => {
    const lists = (collapsed: ReadonlyArray<string>) =>
      visibleFolderLists([{ environmentId: ENV, owners }], new Set(collapsed)).map(
        (list) => list.listKey,
      );
    expect(lists([])).toEqual([
      folderThreadListKey(ENV, PERSONAL, null),
      folderThreadListKey(ENV, PERSONAL, FolderId.make("clients")),
      folderThreadListKey(ENV, PERSONAL, FolderId.make("work")),
      folderThreadListKey(ENV, PERSONAL, FolderId.make("notes")),
      folderThreadListKey(ENV, ACME, null),
      folderThreadListKey(ENV, ACME, FolderId.make("northwind")),
    ]);
    expect(lists([folderNodeKey(ENV, FolderId.make("work")), folderOwnerKey(ENV, ACME)])).toEqual([
      folderThreadListKey(ENV, PERSONAL, null),
      folderThreadListKey(ENV, PERSONAL, FolderId.make("notes")),
    ]);
    // Your top level has no row to fold: a fold saved from the old Personal header changes nothing.
    expect(lists([folderOwnerKey(ENV, PERSONAL)])).toEqual(lists([]));
    // Member levels follow your own, as the tree draws them, whatever order the contexts come in.
    expect(
      visibleFolderLists([{ environmentId: ENV, owners: [...owners].reverse() }], new Set()).map(
        (list) => list.listKey,
      ),
    ).toEqual(lists([]));
  });

  it("offers a thread every other place in its owner's tree, and reads the choice back", () => {
    const menu = moveThreadMenuItem(
      threadFolderChoices(snapshot, PERSONAL, FolderId.make("clients")),
      false,
    );
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
    expect(moveThreadMenuItem([], true).disabled).toBe(true);
  });
});
