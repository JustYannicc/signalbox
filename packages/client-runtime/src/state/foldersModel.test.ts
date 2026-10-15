import { ProjectId, ThreadId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import {
  type Folder,
  FolderId,
  type SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "vite-plus/test";

import {
  folderDeleteMessage,
  folderDestinations,
  folderLevelName,
  folderPath,
  folderSiblingMove,
  folderThreadCounts,
  folderTree,
  homeOfProject,
  homeOfThread,
  isFiledAway,
  newThreadIn,
  ownerFilesProject,
  poolOfHome,
  poolOfTarget,
  threadFolderChoices,
  threadHomeLookup,
} from "./foldersModel.ts";

const PERSONAL = SignalboxContextId.make("personal");
const SCRATCH = ProjectId.make("scratch");
const DRIVE = ProjectId.make("drive:folder/personal/nw");

const folder = (id: string, parentId: string | null, position = 0, extra: Partial<Folder> = {}) =>
  ({
    id: FolderId.make(id),
    name: id[0]!.toUpperCase() + id.slice(1),
    parentId: parentId === null ? null : FolderId.make(parentId),
    position,
    ownerId: PERSONAL,
    ...extra,
  }) satisfies Folder;

/** Work › Clients › Northwind (with its drive's files), and Notes beside Work. */
const snapshot: SignalboxFoldersSnapshot = {
  revision: 3,
  top: {},
  folders: [
    folder("notes", null, 1),
    folder("work", null, 0),
    folder("clients", "work"),
    folder("northwind", "clients", 0, { files: { projectId: DRIVE } }),
  ],
  threadHomes: [{ threadId: ThreadId.make("filed"), folderId: FolderId.make("clients") }],
  projectHomes: [
    { projectId: SCRATCH, folderId: null },
    { projectId: DRIVE, folderId: FolderId.make("northwind") },
  ],
  pools: {
    top: { poolId: "personal", from: { _tag: "top" } },
    folders: [
      {
        folderId: FolderId.make("clients"),
        pool: { poolId: "work", from: { _tag: "folder", folderId: FolderId.make("work") } },
      },
    ],
  },
};

describe("foldersModel", () => {
  it("nests an owner's folders in order", () => {
    const names = (nodes: ReturnType<typeof folderTree>): Array<unknown> =>
      nodes.map((node) =>
        node.children.length === 0
          ? node.folder.name
          : { [node.folder.name]: names(node.children) },
      );
    expect(names(folderTree(snapshot, PERSONAL))).toEqual([
      { Work: [{ Clients: ["Northwind"] }] },
      "Notes",
    ]);
    expect(folderTree(snapshot, SignalboxContextId.make("org_acme"))).toEqual([]);
    expect(folderTree(snapshot, PERSONAL)).toBe(folderTree(snapshot, PERSONAL));
  });

  it("homes a thread where it was filed, else with its project's files, else at the top", () => {
    expect(homeOfThread(snapshot, { id: ThreadId.make("filed"), projectId: SCRATCH })).toBe(
      "clients",
    );
    expect(homeOfThread(snapshot, { id: ThreadId.make("other"), projectId: DRIVE })).toBe(
      "northwind",
    );
    expect(homeOfThread(snapshot, { id: ThreadId.make("loose"), projectId: SCRATCH })).toBeNull();
    const lookup = threadHomeLookup(snapshot);
    expect(lookup({ id: ThreadId.make("filed"), projectId: DRIVE })).toBe("clients");
  });

  it("names a folder's path and resolves its pool", () => {
    expect(folderPath(snapshot, FolderId.make("northwind")).map((entry) => entry.name)).toEqual([
      "Work",
      "Clients",
      "Northwind",
    ]);
    expect(poolOfHome(snapshot, FolderId.make("clients"))?.poolId).toBe("work");
    expect(poolOfHome(snapshot, null)?.poolId).toBe("personal");
  });

  it("never offers a folder itself or anything under it as where it moves", () => {
    expect(
      folderDestinations(snapshot, PERSONAL, FolderId.make("work")).map((entry) => entry.label),
    ).toEqual(["Notes"]);
    expect(folderDestinations(snapshot, PERSONAL).map((entry) => entry.label)).toEqual([
      "Work",
      "Work / Clients",
      "Work / Clients / Northwind",
      "Notes",
    ]);
  });

  it("homes a project's threads with the folder it's the files of", () => {
    expect(homeOfProject(snapshot, DRIVE)).toBe("northwind");
    expect(homeOfProject(snapshot, SCRATCH)).toBeNull();
    expect(homeOfProject(snapshot, ProjectId.make("unknown"))).toBeNull();
  });

  it("moves a folder past its sibling, and nowhere at either end", () => {
    const work = FolderId.make("work");
    const notes = FolderId.make("notes");
    expect(folderSiblingMove(snapshot, work, "up")).toBeNull();
    expect(folderSiblingMove(snapshot, work, "down")).toEqual({ id: work, parentId: null });
    expect(folderSiblingMove(snapshot, notes, "up")).toEqual({
      id: notes,
      parentId: null,
      beforeId: work,
    });
    expect(folderSiblingMove(snapshot, notes, "down")).toBeNull();
    const three = {
      ...snapshot,
      folders: [...snapshot.folders, folder("later", null, 2)],
    };
    expect(folderSiblingMove(three, work, "down")).toEqual({
      id: work,
      parentId: null,
      beforeId: FolderId.make("later"),
    });
    expect(folderSiblingMove(snapshot, FolderId.make("northwind"), "down")).toBeNull();
  });

  it("starts a thread in a folder's files, filing it only when its project lives elsewhere", () => {
    expect(newThreadIn(snapshot, FolderId.make("northwind"), SCRATCH)).toEqual({
      projectId: DRIVE,
      file: false,
    });
    expect(newThreadIn(snapshot, FolderId.make("clients"), SCRATCH)).toEqual({
      projectId: SCRATCH,
      file: true,
    });
    expect(newThreadIn(snapshot, null, SCRATCH)).toEqual({ projectId: SCRATCH, file: false });
  });

  it("tells a thread filed away from its project's home from one living there", () => {
    // Started in Clients, which shares Personal's files: a plain New must not reuse it.
    expect(isFiledAway(snapshot, { id: ThreadId.make("filed"), projectId: SCRATCH })).toBe(true);
    expect(isFiledAway(snapshot, { id: ThreadId.make("loose"), projectId: SCRATCH })).toBe(false);
    expect(isFiledAway(snapshot, { id: ThreadId.make("loose"), projectId: DRIVE })).toBe(false);
    const filedToTop: SignalboxFoldersSnapshot = {
      ...snapshot,
      threadHomes: [{ threadId: ThreadId.make("moved"), folderId: null }],
    };
    expect(isFiledAway(filedToTop, { id: ThreadId.make("moved"), projectId: DRIVE })).toBe(true);
  });

  it("keeps one lookup per snapshot, so its identity only changes with the folders", () => {
    expect(threadHomeLookup(snapshot)).toBe(threadHomeLookup(snapshot));
    expect(threadHomeLookup({ ...snapshot })).not.toBe(threadHomeLookup(snapshot));
  });

  it("resolves the pool of a folder, a thread, a new thread in a project, or the top level", () => {
    expect(
      poolOfTarget(snapshot, { projectId: SCRATCH, folderId: FolderId.make("clients") })?.poolId,
    ).toBe("work");
    expect(
      poolOfTarget(snapshot, { projectId: SCRATCH, threadId: ThreadId.make("filed") })?.poolId,
    ).toBe("work");
    expect(poolOfTarget(snapshot, { projectId: SCRATCH })?.poolId).toBe("personal");
    expect(poolOfTarget(snapshot, { projectId: null })?.poolId).toBe("personal");
  });

  it("names where a pool is placed", () => {
    expect(folderLevelName(snapshot, { _tag: "top" })).toBe("the top level");
    expect(folderLevelName(snapshot, { _tag: "folder", folderId: FolderId.make("work") })).toBe(
      "Work",
    );
    expect(
      folderLevelName(snapshot, { _tag: "folder", folderId: FolderId.make("gone") }),
    ).toBeNull();
  });

  it("offers a thread its owner's top level and every folder, its home checked", () => {
    expect(
      threadFolderChoices(snapshot, PERSONAL, FolderId.make("clients")).map((choice) => [
        choice.folderId,
        choice.label,
        choice.checked,
      ]),
    ).toEqual([
      [null, "Top level", false],
      ["work", "Work", false],
      ["clients", "Work / Clients", true],
      ["northwind", "Work / Clients / Northwind", false],
      ["notes", "Notes", false],
    ]);
  });

  it("says where a deleted folder's contents go", () => {
    const byId = (id: string) => snapshot.folders.find((entry) => entry.id === id)!;
    expect(folderDeleteMessage(snapshot, byId("clients"))).toBe(
      "Its folders and threads move up to “Work”. No thread or file is deleted.",
    );
    expect(folderDeleteMessage(snapshot, byId("work"))).toBe(
      "Its folders and threads move up to the top level. No thread or file is deleted.",
    );
  });

  it("counts live threads in each folder and everything below it", () => {
    const counts = folderThreadCounts(snapshot, [
      { id: ThreadId.make("filed"), projectId: SCRATCH },
      { id: ThreadId.make("in-northwind"), projectId: DRIVE },
      { id: ThreadId.make("archived"), projectId: DRIVE, archivedAt: "2026-10-01T00:00:00Z" },
      { id: ThreadId.make("loose"), projectId: SCRATCH },
    ]);
    expect(Object.fromEntries(counts)).toEqual({ work: 2, clients: 2, northwind: 1 });
  });

  it("names an owner's own files", () => {
    expect(
      ownerFilesProject({
        id: PERSONAL,
        kind: "personal",
        name: "Personal",
        projectIds: [SCRATCH],
      }),
    ).toBe(SCRATCH);
    expect(
      ownerFilesProject({ id: PERSONAL, kind: "personal", name: "Personal", projectIds: [] }),
    ).toBeNull();
  });
});
