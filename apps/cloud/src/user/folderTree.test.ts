import { ProjectId, ThreadId } from "@t3tools/contracts";
import { PERSONAL_CONTEXT_ID, SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId, OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "@effect/vitest";

import {
  folderOfProject,
  homeOf,
  instructionsOf,
  isWithin,
  poolResolver,
  secretResolutionOf,
  secretsOf,
  type Tree,
  type TreeFolder,
  withSoundParents,
} from "./folderTree.ts";

const ACME = SignalboxContextId.make("org_acme");
const id = FolderId.make;

const folder = (
  name: string,
  parentId: string | null,
  extra: Partial<TreeFolder> = {},
): TreeFolder => ({
  id: id(name.toLowerCase()),
  ownerId: PERSONAL_CONTEXT_ID,
  parentId: parentId === null ? null : id(parentId),
  name,
  position: 0,
  driveId: null,
  instructions: null,
  secrets: null,
  phase: null,
  ...extra,
});

/** Work › Clients › Northwind (with its drive's files), and Acme's Payments. */
const tree = (overrides: Partial<Tree> = {}): Tree => ({
  folders: [
    folder("Work", null, { instructions: "Write in English." }),
    folder("Clients", "work"),
    folder("Northwind", "clients", { driveId: "folder/personal/nw", instructions: "Bill hourly." }),
    folder("Payments", null, { ownerId: ACME }),
  ],
  topInstructions: "Be brief.",
  topSecrets: null,
  bindings: [
    { level: { _tag: "top" }, poolId: "personal", reach: "below" },
    { level: { _tag: "folder", folderId: id("work") }, poolId: "work", reach: "below" },
  ],
  filed: new Map(),
  driveOfProject: (projectId) =>
    projectId.startsWith("drive:") ? projectId.slice("drive:".length) : null,
  ...overrides,
});

const NORTHWIND_FILES = ProjectId.make("drive:folder/personal/nw");
const SCRATCH = ProjectId.make("scratch");
const thread = ThreadId.make("thread-1");

describe("folderTree", () => {
  it("homes a thread where it was filed, else where its project's files are, else the top level", () => {
    expect(homeOf(tree(), { threadId: thread, projectId: NORTHWIND_FILES, ownerId: null })).toBe(
      "northwind",
    );
    expect(homeOf(tree(), { threadId: thread, projectId: SCRATCH, ownerId: null })).toBeNull();
    expect(folderOfProject(tree(), SCRATCH)).toBeNull();

    const filed = tree({ filed: new Map([[thread, id("clients")]]) });
    expect(homeOf(filed, { threadId: thread, projectId: NORTHWIND_FILES, ownerId: null })).toBe(
      "clients",
    );
    // Filed at the top level beats its project's folder.
    const atTop = tree({ filed: new Map([[thread, null]]) });
    expect(
      homeOf(atTop, { threadId: thread, projectId: NORTHWIND_FILES, ownerId: null }),
    ).toBeNull();
  });

  it("never homes a thread outside its owner's tree, or in a folder that's gone", () => {
    const elsewhere = tree({ filed: new Map([[thread, id("payments")]]) });
    expect(
      homeOf(elsewhere, { threadId: thread, projectId: SCRATCH, ownerId: PERSONAL_CONTEXT_ID }),
    ).toBeNull();
    expect(homeOf(elsewhere, { threadId: thread, projectId: SCRATCH, ownerId: ACME })).toBe(
      "payments",
    );
    const gone = tree({ filed: new Map([[thread, id("deleted")]]) });
    expect(homeOf(gone, { threadId: thread, projectId: NORTHWIND_FILES, ownerId: null })).toBe(
      "northwind",
    );
  });

  it("cascades AGENTS.md from the top level down each folder to the home", () => {
    expect(instructionsOf(tree(), id("northwind"))).toEqual([
      { label: "Top level", text: "Be brief." },
      { label: "Work", text: "Write in English." },
      // Clients has none, so it adds nothing.
      { label: "Work / Clients / Northwind", text: "Bill hourly." },
    ]);
    expect(instructionsOf(tree(), null)).toEqual([{ label: "Top level", text: "Be brief." }]);
    expect(instructionsOf(tree({ topInstructions: null }), id("payments"))).toEqual([]);
  });

  it("gives ancestors only opted-in names and the home its full Environment", () => {
    const env = OnePasswordEnvironmentId.make;
    const named = tree({
      topSecrets: { environmentId: env("top"), includeSubfolders: ["TOP_KEY"] },
      folders: tree().folders.map((each) =>
        each.name === "Work"
          ? {
              ...each,
              secrets: { environmentId: env("work"), includeSubfolders: ["WORK_KEY"] },
            }
          : each.name === "Northwind"
            ? { ...each, secrets: { environmentId: env("northwind") } }
            : each,
      ),
    });
    expect(secretsOf(named, id("northwind"))).toEqual(["top", "work", "northwind"]);
    expect(secretsOf(named, id("clients"))).toEqual(["top", "work"]);
    expect(secretResolutionOf(named, id("clients")).environmentNames).toEqual([
      ["TOP_KEY"],
      ["WORK_KEY"],
    ]);
    expect(secretsOf(tree(), id("northwind"))).toEqual([]);
  });

  it("keeps repeated Environment assignments in chain order with their own name filters", () => {
    const envA = OnePasswordEnvironmentId.make("env-a");
    const envB = OnePasswordEnvironmentId.make("env-b");
    const repeated = tree({
      topSecrets: { environmentId: envA, includeSubfolders: ["X"] },
      folders: tree().folders.map((each) =>
        each.name === "Work"
          ? {
              ...each,
              secrets: {
                environmentId: envB,
                includeSubfolders: ["X"],
              },
            }
          : each.name === "Clients"
            ? { ...each, secrets: { environmentId: envA, includeSubfolders: ["Y"] } }
            : each,
      ),
    });

    expect(secretResolutionOf(repeated, id("northwind"))).toEqual({
      environments: ["env-a", "env-b", "env-a"],
      environmentNames: [["X"], ["X"], ["Y"]],
    });
  });

  it("does not let an empty nearer allowlist revoke names shared above", () => {
    const envA = OnePasswordEnvironmentId.make("env-a");
    const envB = OnePasswordEnvironmentId.make("env-b");
    const emptyNearerAssignment = tree({
      topSecrets: { environmentId: envA, includeSubfolders: ["X"] },
      folders: tree().folders.map((each) =>
        each.name === "Work"
          ? { ...each, secrets: { environmentId: envB, includeSubfolders: ["X"] } }
          : each.name === "Clients"
            ? { ...each, secrets: { environmentId: envA, includeSubfolders: [] } }
            : each,
      ),
    });

    expect(secretResolutionOf(emptyNearerAssignment, id("northwind"))).toEqual({
      environments: ["env-a", "env-b"],
      environmentNames: [["X"], ["X"]],
    });
  });

  it("runs every folder on the nearest pool up its chain, at any depth", () => {
    const deep = tree({
      folders: [
        ...tree().folders,
        ...["a", "b", "c", "d", "e", "f"].map((name, index, all) =>
          folder(name, index === 0 ? "northwind" : all[index - 1]!),
        ),
      ],
    });
    const poolOf = poolResolver(deep);
    expect(poolOf(id("f"))?.poolId).toBe("work");
    expect(poolOf(id("payments"))?.poolId).toBe("personal");
    expect(poolOf(null)?.poolId).toBe("personal");
    expect(isWithin(deep, id("f"), id("clients"))).toBe(true);
    expect(isWithin(deep, id("clients"), id("f"))).toBe(false);
  });

  it("puts a folder whose parent is gone, another owner's or in a cycle at the top level", () => {
    const sound = withSoundParents([
      folder("A", "b"),
      folder("B", "a"),
      folder("Leaf", "a"),
      folder("Orphan", "gone"),
      folder("Foreign", "payments"),
      folder("Payments", null, { ownerId: ACME }),
    ]);
    const parentOf = (name: string) => sound.find((entry) => entry.name === name)?.parentId;
    // Both of the cycle go to the top; one only hanging below it keeps its parent.
    expect(parentOf("A")).toBeNull();
    expect(parentOf("B")).toBeNull();
    expect(parentOf("Leaf")).toBe("a");
    expect(parentOf("Orphan")).toBeNull();
    expect(parentOf("Foreign")).toBeNull();
    // So every chain reaches the top level, and with it the top's pool and AGENTS.md.
    const cyclic = tree({ folders: sound });
    expect(instructionsOf(cyclic, id("leaf"))[0]).toEqual({
      label: "Top level",
      text: "Be brief.",
    });
  });
});
