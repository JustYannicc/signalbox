import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import {
  type Folder,
  FolderId,
  OnePasswordEnvironmentId,
  type SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "vite-plus/test";

import {
  formatSources,
  levelSecrets,
  planSecretsSave,
  secretSourcesAbove,
} from "./folderSecretsModel";

const PERSONAL = SignalboxContextId.make("personal");
const env = (id: string) => OnePasswordEnvironmentId.make(id);

const folder = (id: string, parentId: string | null, environmentId?: string) =>
  ({
    id: FolderId.make(id),
    name: id[0]!.toUpperCase() + id.slice(1),
    parentId: parentId === null ? null : FolderId.make(parentId),
    position: 0,
    ownerId: PERSONAL,
    ...(environmentId === undefined ? {} : { secrets: { environmentId: env(environmentId) } }),
  }) satisfies Folder;

/** Work (secrets) › Clients › Northwind (secrets), under a top level with secrets. */
const snapshot: SignalboxFoldersSnapshot = {
  revision: 1,
  top: { secrets: { environmentId: env("top-env") } },
  folders: [
    folder("work", null, "work-env"),
    folder("clients", "work"),
    folder("northwind", "clients", "nw-env"),
  ],
  threadHomes: [],
  projectHomes: [],
  pools: { top: null, folders: [] },
};

const level = (folderId: string) => ({
  _tag: "folder" as const,
  folderId: FolderId.make(folderId),
});

describe("levelSecrets", () => {
  it("answers the Environment the level names itself", () => {
    expect(levelSecrets(snapshot, { _tag: "top" })).toBe("top-env");
    expect(levelSecrets(snapshot, level("northwind"))).toBe("nw-env");
    expect(levelSecrets(snapshot, level("clients"))).toBeNull();
    expect(levelSecrets(snapshot, level("gone"))).toBeNull();
  });
});

describe("secretSourcesAbove", () => {
  it("names every level above with an Environment, nearest first, top level last", () => {
    expect(secretSourcesAbove(snapshot, level("northwind"))).toEqual(["“Work”", "the top level"]);
    expect(secretSourcesAbove(snapshot, level("work"))).toEqual(["the top level"]);
    expect(secretSourcesAbove(snapshot, { _tag: "top" })).toEqual([]);
  });

  it("leaves out levels that name none", () => {
    const bare = { ...snapshot, top: {} };
    expect(secretSourcesAbove(bare, level("work"))).toEqual([]);
    expect(secretSourcesAbove(bare, level("northwind"))).toEqual(["“Work”"]);
  });

  it("reads as a list", () => {
    expect(formatSources(["“Work”"])).toBe("“Work”");
    expect(formatSources(["“Clients”", "“Work”", "the top level"])).toBe(
      "“Clients”, “Work” and the top level",
    );
  });
});

describe("planSecretsSave", () => {
  const base = { current: null, environmentId: "", token: null, connected: true } as const;

  it("does nothing when nothing changed", () => {
    expect(planSecretsSave({ ...base, current: env("a"), environmentId: " a " })).toEqual({
      connect: null,
    });
  });

  it("names, replaces and removes the level's Environment", () => {
    expect(planSecretsSave({ ...base, environmentId: "abc_12-x" })).toEqual({
      connect: null,
      environmentId: "abc_12-x",
    });
    expect(planSecretsSave({ ...base, current: env("a"), environmentId: "" })).toEqual({
      connect: null,
      environmentId: null,
    });
  });

  it("refuses an id 1Password wouldn't give", () => {
    expect(planSecretsSave({ ...base, environmentId: "not an id" })).toHaveProperty("error");
  });

  it("needs a token to read an Environment when none is connected", () => {
    expect(
      planSecretsSave({ ...base, connected: false, environmentId: "abc", token: "" }),
    ).toHaveProperty("error");
    expect(
      planSecretsSave({ ...base, connected: false, environmentId: "abc", token: " ops_secret " }),
    ).toEqual({ connect: "ops_secret", environmentId: "abc" });
  });

  it("connects a token on its own, but only one shaped like 1Password's", () => {
    expect(planSecretsSave({ ...base, connected: false, token: "ops_secret" })).toEqual({
      connect: "ops_secret",
    });
    expect(planSecretsSave({ ...base, token: "sk-nope" })).toHaveProperty("error");
  });

  it("ignores a token field that isn't shown", () => {
    expect(planSecretsSave({ ...base, environmentId: "abc", token: null })).toEqual({
      connect: null,
      environmentId: "abc",
    });
  });
});
