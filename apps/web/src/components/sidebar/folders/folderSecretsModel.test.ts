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

const folder = (
  id: string,
  parentId: string | null,
  environmentId?: string,
  includeSubfolders?: ReadonlyArray<string>,
) =>
  ({
    id: FolderId.make(id),
    name: id[0]!.toUpperCase() + id.slice(1),
    parentId: parentId === null ? null : FolderId.make(parentId),
    position: 0,
    ownerId: PERSONAL,
    ...(environmentId === undefined
      ? {}
      : {
          secrets: {
            environmentId: env(environmentId),
            ...(includeSubfolders === undefined ? {} : { includeSubfolders }),
          },
        }),
  }) satisfies Folder;

/** Work (opted in) › Clients › Northwind, under a top level that opted in. */
const snapshot: SignalboxFoldersSnapshot = {
  revision: 1,
  top: { secrets: { environmentId: env("top-env"), includeSubfolders: ["ROOT_KEY"] } },
  folders: [
    folder("work", null, "work-env", ["WORK_KEY"]),
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
    expect(levelSecrets(snapshot, { _tag: "top" })).toEqual({
      environmentId: "top-env",
      includeSubfolders: ["ROOT_KEY"],
    });
    expect(levelSecrets(snapshot, level("northwind"))).toEqual({ environmentId: "nw-env" });
    expect(levelSecrets(snapshot, level("clients"))).toBeNull();
    expect(levelSecrets(snapshot, level("gone"))).toBeNull();
  });
});

describe("secretSourcesAbove", () => {
  it("names opted-in sources above, nearest first, top level last", () => {
    expect(secretSourcesAbove(snapshot, level("northwind"))).toEqual(["“Work”", "the top level"]);
    expect(secretSourcesAbove(snapshot, level("work"))).toEqual(["the top level"]);
    expect(secretSourcesAbove(snapshot, { _tag: "top" })).toEqual([]);
  });

  it("leaves out levels that have no opted-in names", () => {
    const bare = { ...snapshot, top: {} };
    expect(secretSourcesAbove(bare, level("work"))).toEqual([]);
    expect(secretSourcesAbove(bare, level("northwind"))).toEqual(["“Work”"]);
    const defaults: SignalboxFoldersSnapshot = {
      ...snapshot,
      top: { secrets: { environmentId: env("top-env") } },
      folders: snapshot.folders.map((candidate) =>
        candidate.id === "work"
          ? { ...candidate, secrets: { environmentId: env("work-env"), includeSubfolders: [] } }
          : candidate,
      ),
    };
    expect(secretSourcesAbove(defaults, level("northwind"))).toEqual([]);
  });

  it("reads as a list", () => {
    expect(formatSources(["“Work”"])).toBe("“Work”");
    expect(formatSources(["“Clients”", "“Work”", "the top level"])).toBe(
      "“Clients”, “Work” and the top level",
    );
  });
});

describe("planSecretsSave", () => {
  const base = {
    current: null,
    environmentId: "",
    includeSubfolders: [],
    token: null,
    connected: true,
  } as const;

  it("does nothing when nothing changed", () => {
    expect(
      planSecretsSave({
        ...base,
        current: { environmentId: env("a"), includeSubfolders: ["API_KEY"] },
        environmentId: " a ",
        includeSubfolders: ["API_KEY"],
      }),
    ).toEqual({
      connect: null,
    });
  });

  it("names, replaces and removes the level's Environment", () => {
    expect(planSecretsSave({ ...base, environmentId: "abc_12-x" })).toEqual({
      connect: null,
      secrets: { environmentId: "abc_12-x", includeSubfolders: [] },
    });
    expect(
      planSecretsSave({
        ...base,
        current: { environmentId: env("a"), includeSubfolders: ["API_KEY"] },
        environmentId: "",
      }),
    ).toEqual({
      connect: null,
      secrets: null,
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
    ).toEqual({
      connect: "ops_secret",
      secrets: { environmentId: "abc", includeSubfolders: [] },
    });
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
      secrets: { environmentId: "abc", includeSubfolders: [] },
    });
  });
});
