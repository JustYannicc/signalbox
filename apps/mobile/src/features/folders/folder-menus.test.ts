import { describe, expect, it } from "@effect/vitest";
import { FolderId } from "@t3tools/contracts/signalboxFolders";

import {
  deleteFolderMessage,
  folderMenuActions,
  folderSiblingMoveInput,
  parseFolderMenuEvent,
  parseThreadFolderMenuEvent,
  threadFolderMenuActions,
  topLevelMenuActions,
} from "./folder-menus";
import { ACME, PERSONAL, snapshot } from "./folder-fixtures.test-support";

const byId = (id: string) => snapshot.folders.find((folder) => folder.id === id)!;
const pools = [
  { id: "personal", name: "Personal" },
  { id: "work", name: "Work" },
];

describe("a folder's menu", () => {
  it("moves anywhere in its owner's tree except inside itself", () => {
    const move = folderMenuActions({ snapshot, folder: byId("clients"), pools }).find(
      (action) => action.id === "folder:move",
    );
    expect(move?.subactions?.map((action) => [action.title, action.state])).toEqual([
      ["Top level", undefined],
      ["Work", "on"],
      ["Notes", undefined],
    ]);
  });

  it("reorders only where there's a sibling to pass", () => {
    const ids = (name: string) =>
      folderMenuActions({ snapshot, folder: byId(name), pools }).map((action) => action.id);
    expect(ids("work")).toContain("folder:down");
    expect(ids("work")).not.toContain("folder:up");
    expect(ids("notes")).toContain("folder:up");
    expect(ids("notes")).not.toContain("folder:down");
    expect(ids("clients")).not.toContain("folder:up");
  });

  it("offers the pools with its own checked and names what it would inherit", () => {
    const choices = folderMenuActions({ snapshot, folder: byId("clients"), pools }).find(
      (action) => action.id === "folder:pool",
    );
    expect(choices?.subactions?.map((action) => [action.title, action.state])).toEqual([
      ["Inherit from above (Work)", "on"],
      ["Personal", undefined],
      ["Work", undefined],
    ]);
    const single = folderMenuActions({ snapshot, folder: byId("clients"), pools: pools.slice(1) });
    expect(single.some((action) => action.id === "folder:pool")).toBe(false);
  });

  it("ends with instructions and delete", () => {
    const actions = folderMenuActions({ snapshot, folder: byId("notes"), pools });
    expect(actions.slice(-2).map((action) => action.title)).toEqual([
      "Instructions…",
      "Delete folder",
    ]);
  });

  it("turns choices back into changes, and nothing for no-ops", () => {
    const work = byId("work");
    expect(parseFolderMenuEvent(snapshot, work, "folder:down")).toEqual({
      _tag: "move",
      input: { id: "work", parentId: null },
    });
    expect(parseFolderMenuEvent(snapshot, byId("notes"), "folder:up")).toEqual({
      _tag: "move",
      input: { id: "notes", parentId: null, beforeId: "work" },
    });
    expect(parseFolderMenuEvent(snapshot, byId("clients"), "folder:parent:top")).toEqual({
      _tag: "move",
      input: { id: "clients", parentId: null },
    });
    expect(parseFolderMenuEvent(snapshot, byId("clients"), "folder:parent:work")).toBeNull();
    expect(parseFolderMenuEvent(snapshot, work, "folder:parent:northwind")).toBeNull();
    expect(parseFolderMenuEvent(snapshot, work, "folder:pool:work")).toBeNull();
    expect(parseFolderMenuEvent(snapshot, work, "folder:pool:inherit")).toEqual({
      _tag: "pool",
      poolId: null,
    });
    expect(parseFolderMenuEvent(snapshot, byId("notes"), "folder:pool:work")).toEqual({
      _tag: "pool",
      poolId: "work",
    });
  });

  it("puts a middle folder before the one after its next sibling", () => {
    const three = {
      ...snapshot,
      folders: [
        ...snapshot.folders,
        { ...byId("notes"), id: FolderId.make("later"), name: "Later", position: 2 },
      ],
    };
    expect(folderSiblingMoveInput(three, byId("work"), "down")).toEqual({
      id: "work",
      parentId: null,
      beforeId: "later",
    });
  });

  it("says where a deleted folder's contents go", () => {
    expect(deleteFolderMessage(snapshot, byId("clients"))).toBe(
      "Its folders and threads move up to Work. No thread or file is deleted.",
    );
    expect(deleteFolderMessage(snapshot, byId("work"))).toBe(
      "Its folders and threads move up to the top level. No thread or file is deleted.",
    );
  });
});

describe("an owner's top level", () => {
  it("has instructions of its own only for Personal", () => {
    expect(topLevelMenuActions({ personal: true }).map((action) => action.id)).toEqual([
      "top:new-folder",
      "top:instructions",
    ]);
    expect(topLevelMenuActions({ personal: false }).map((action) => action.id)).toEqual([
      "top:new-folder",
    ]);
  });
});

describe("moving a thread", () => {
  const placement = { snapshot, ownerId: PERSONAL, home: FolderId.make("clients") };

  it("lists the owner's top level and folders with its home checked", () => {
    const [menu] = threadFolderMenuActions(placement);
    expect(menu?.title).toBe("Move to folder");
    expect(menu?.subactions?.map((action) => [action.title, action.state])).toEqual([
      ["Top level", undefined],
      ["Work", undefined],
      ["Work / Clients", "on"],
      ["Work / Clients / Northwind", undefined],
      ["Notes", undefined],
    ]);
  });

  it("is absent while the owner has no folders", () => {
    const empty = { ...snapshot, folders: snapshot.folders.filter((f) => f.ownerId !== ACME) };
    expect(threadFolderMenuActions({ snapshot: empty, ownerId: ACME, home: null })).toEqual([]);
  });

  it("files it in the chosen folder of its owner's, and ignores where it already is", () => {
    expect(parseThreadFolderMenuEvent(placement, "thread-folder:top")).toEqual({ folderId: null });
    expect(parseThreadFolderMenuEvent(placement, "thread-folder:in:notes")).toEqual({
      folderId: "notes",
    });
    expect(parseThreadFolderMenuEvent(placement, "thread-folder:in:clients")).toBeUndefined();
    expect(parseThreadFolderMenuEvent(placement, "thread-folder:in:ops")).toBeUndefined();
    expect(parseThreadFolderMenuEvent(placement, "rename")).toBeUndefined();
  });
});
