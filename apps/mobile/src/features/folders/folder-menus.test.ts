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
  });

  it("offers the pool choice with one pool only where one is set, so it can be reset", () => {
    const one = pools.slice(1);
    const has = (name: string) =>
      folderMenuActions({ snapshot, folder: byId(name), pools: one }).some(
        (action) => action.id === "folder:pool",
      );
    expect(has("work")).toBe(true);
    expect(has("clients")).toBe(false);
  });

  it("offers publishing to GitHub only to someone who may publish the folder", () => {
    const has = (publishable: boolean) =>
      folderMenuActions({ snapshot, folder: byId("work"), pools, publishable }).some(
        (action) => action.id === "folder:publish",
      );
    expect(has(true)).toBe(true);
    expect(has(false)).toBe(false);
    expect(parse("work", "folder:publish")).toEqual({ _tag: "publish" });
  });

  it("ends with instructions and delete", () => {
    const actions = folderMenuActions({ snapshot, folder: byId("notes"), pools });
    expect(actions.slice(-2).map((action) => action.title)).toEqual([
      "Instructions…",
      "Delete folder",
    ]);
  });

  it("moves between its phases by position, and edits them or adds some", () => {
    const work = {
      ...byId("work"),
      phase: { phases: ["Idea", "Doing/now", "Done"], current: "Idea" },
    };
    const phase = folderMenuActions({ snapshot, folder: work, pools }).find(
      (action) => action.id === "folder:phase",
    );
    expect(phase?.subactions?.map((action) => [action.id, action.title, action.state])).toEqual([
      ["folder:phase:0", "Idea", "on"],
      ["folder:phase:1", "Doing/now", undefined],
      ["folder:phase:2", "Done", undefined],
      ["folder:phases", "Edit phases…", undefined],
    ]);
    const choose = (event: string) =>
      parseFolderMenuEvent({ snapshot, folder: work, pools, event });
    expect(choose("folder:phase:1")).toEqual({ _tag: "phase", current: "Doing/now" });
    expect(choose("folder:phase:0")).toBeNull();
    expect(choose("folder:phase:9")).toBeNull();
    expect(
      folderMenuActions({ snapshot, folder: byId("notes"), pools }).map((action) => action.id),
    ).toContain("folder:phases");
    expect(parse("notes", "folder:phases")).toEqual({ _tag: "phases" });
  });

  it("opens the folder's notes only where the environment keeps them", () => {
    const ids = (notes: boolean) =>
      folderMenuActions({ snapshot, folder: byId("notes"), pools, notes }).map(
        (action) => action.id,
      );
    expect(ids(true).slice(-3)).toEqual(["folder:notes", "folder:instructions", "folder:delete"]);
    expect(ids(false)).not.toContain("folder:notes");
    expect(parse("notes", "folder:notes")).toEqual({ _tag: "notes" });
  });

  it("offers lending the user's GitHub on a folder with files, naming the account while lent", () => {
    const lend = (target: Parameters<typeof byId>[0] | ReturnType<typeof byId>) =>
      folderMenuActions({
        snapshot,
        folder: typeof target === "string" ? byId(target) : target,
        pools,
      }).find((action) => action.id === "folder:github-lend");
    expect(lend("notes")).toBeUndefined();
    expect(lend("northwind")).toMatchObject({
      title: "Lend my GitHub to CI steps",
      state: undefined,
    });
    const lent = { ...byId("northwind"), githubLend: { login: "octo", lentAt: 1 } };
    expect(lend(lent)).toMatchObject({ title: "CI steps run as @octo", state: "on" });
    // A lend whose files went away can still be seen and stopped.
    expect(lend({ ...byId("notes"), githubLend: { login: "octo", lentAt: 1 } })?.state).toBe("on");
    // Choosing it flips the lend: on when not lent, off when lent.
    expect(parse("northwind", "folder:github-lend")).toEqual({ _tag: "githubLend", lent: true });
    expect(
      parseFolderMenuEvent({ snapshot, folder: lent, pools, event: "folder:github-lend" }),
    ).toEqual({ _tag: "githubLend", lent: false });
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

  it("has a notes pad only for Personal, where the environment keeps notes", () => {
    expect(topLevelMenuActions({ personal: true, notes: true }).map((action) => action.id)).toEqual(
      ["top:new-folder", "top:notes", "top:instructions"],
    );
    expect(
      topLevelMenuActions({ personal: false, notes: true }).map((action) => action.id),
    ).toEqual(["top:new-folder"]);
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
