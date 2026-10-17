import { describe, expect, it } from "@effect/vitest";
import { threadFolderChoices } from "@t3tools/client-runtime/state/signalboxFolders";
import { AccountPoolId } from "@t3tools/contracts/accountHub";
import { FolderId } from "@t3tools/contracts/signalboxFolders";

import {
  folderMenuActions,
  parseFolderMenuEvent,
  parseThreadFolderMenuEvent,
  threadFolderMenuActions,
  topLevelMenuActions,
} from "./folder-menus";
import { ACME, PERSONAL, snapshot } from "./folder-fixtures.test-support";

const byId = (id: string) => snapshot.folders.find((folder) => folder.id === id)!;
const pools = [
  { id: AccountPoolId.make("personal"), name: "Personal" },
  { id: AccountPoolId.make("work"), name: "Work" },
];
const parse = (folder: string, event: string) =>
  parseFolderMenuEvent({ snapshot, folder: byId(folder), pools, event });
const menu = (folder: string, canStartFrom = true) =>
  folderMenuActions({ snapshot, folder: byId(folder), pools, canStartFrom });

describe("a folder's menu", () => {
  it("moves anywhere in its owner's tree except inside itself", () => {
    const move = menu("clients").find((action) => action.id === "folder:move");
    expect(move?.subactions?.map((action) => [action.title, action.state])).toEqual([
      ["Top level", undefined],
      ["Work", "on"],
      ["Notes", undefined],
    ]);
  });

  it("reorders only where there's a sibling to pass", () => {
    const ids = (name: string) => menu(name).map((action) => action.id);
    expect(ids("work")).toContain("folder:down");
    expect(ids("work")).not.toContain("folder:up");
    expect(ids("notes")).toContain("folder:up");
    expect(ids("notes")).not.toContain("folder:down");
    expect(ids("clients")).not.toContain("folder:up");
  });

  it("offers the pools with its own checked and names what it would inherit", () => {
    const choices = menu("clients").find((action) => action.id === "folder:pool");
    expect(choices?.subactions?.map((action) => [action.title, action.state])).toEqual([
      ["Inherit from above (Work)", "on"],
      ["Personal", undefined],
      ["Work", undefined],
    ]);
  });

  it("offers the pool choice with one pool only where one is set, so it can be reset", () => {
    const one = pools.slice(1);
    const has = (name: string) =>
      folderMenuActions({ snapshot, folder: byId(name), pools: one, canStartFrom: true }).some(
        (action) => action.id === "folder:pool",
      );
    expect(has("work")).toBe(true);
    expect(has("clients")).toBe(false);
  });

  it("offers start-from while keeping the existing delete action", () => {
    const actions = menu("notes");
    expect(actions.map((action) => action.id)).toContain("folder:start-from");
    expect(actions.slice(-2).map((action) => action.title)).toEqual([
      "Instructions…",
      "Delete folder",
    ]);
    expect(parse("notes", "folder:start-from")).toEqual({ _tag: "startFrom" });
    expect(menu("notes", false).map((action) => action.id)).not.toContain("folder:start-from");
  });

  it("turns choices back into changes, and nothing for no-ops", () => {
    expect(parse("work", "folder:down")).toEqual({
      _tag: "move",
      input: { id: "work", parentId: null },
    });
    expect(parse("notes", "folder:up")).toEqual({
      _tag: "move",
      input: { id: "notes", parentId: null, beforeId: "work" },
    });
    expect(parse("clients", "folder:parent:top")).toEqual({
      _tag: "move",
      input: { id: "clients", parentId: null },
    });
    expect(parse("clients", "folder:parent:work")).toBeNull();
    expect(parse("work", "folder:parent:northwind")).toBeNull();
    expect(parse("work", "folder:pool:work")).toBeNull();
    expect(parse("work", "folder:pool:unknown")).toBeNull();
    expect(parse("work", "folder:pool:inherit")).toEqual({ _tag: "pool", poolId: null });
    expect(parse("notes", "folder:pool:work")).toEqual({ _tag: "pool", poolId: "work" });
    expect(parse("notes", "folder:delete")).toEqual({ _tag: "delete" });
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
  const choices = threadFolderChoices(snapshot, PERSONAL, FolderId.make("clients"));

  it("lists the owner's top level and folders with its home checked", () => {
    const [menu] = threadFolderMenuActions(choices);
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
    expect(threadFolderMenuActions(threadFolderChoices(empty, ACME, null))).toEqual([]);
  });

  it("files it in the chosen folder, and ignores where it already is", () => {
    expect(parseThreadFolderMenuEvent(choices, "thread-folder:top")).toEqual({ folderId: null });
    expect(parseThreadFolderMenuEvent(choices, "thread-folder:in:notes")).toEqual({
      folderId: "notes",
    });
    expect(parseThreadFolderMenuEvent(choices, "thread-folder:in:clients")).toBeUndefined();
    expect(parseThreadFolderMenuEvent(choices, "thread-folder:in:ops")).toBeUndefined();
    expect(parseThreadFolderMenuEvent(choices, "rename")).toBeUndefined();
  });
});
