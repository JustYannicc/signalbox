import { type AutomationBlockLibraryEntry, EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  type SignalboxContextsSnapshot,
  SignalboxContextId,
} from "@t3tools/contracts/signalboxContexts";
import {
  type Folder,
  FolderId,
  type SignalboxFoldersSnapshot,
} from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "vite-plus/test";

import {
  blockLibraryTargets,
  groupBlockLibrary,
} from "@t3tools/client-runtime/automations/blockLibrary";

const ENV = EnvironmentId.make("cloud");
const PERSONAL = SignalboxContextId.make("personal");
const ACME = SignalboxContextId.make("org:acme");
const SCRATCH = ProjectId.make("scratch");
const ACME_FILES = ProjectId.make("context:acme");
const WORK = ProjectId.make("drive:work");
const NORTHWIND = ProjectId.make("drive:northwind");

const folder = (
  id: string,
  parentId: string | null,
  files: ProjectId | null,
  ownerId = PERSONAL,
): Folder => ({
  id: FolderId.make(id),
  name: id[0]!.toUpperCase() + id.slice(1),
  parentId: parentId === null ? null : FolderId.make(parentId),
  position: 0,
  ownerId,
  ...(files === null ? {} : { files: { projectId: files } }),
});

const contexts: SignalboxContextsSnapshot = {
  contexts: [
    { id: PERSONAL, kind: "personal", name: "Personal", projectIds: [SCRATCH, WORK, NORTHWIND] },
    { id: ACME, kind: "organization", name: "Acme", projectIds: [ACME_FILES] },
  ],
};

/** Work (files) › Clients (no files) › Northwind (files); Acme › Ops (no files). */
const snapshot: SignalboxFoldersSnapshot = {
  revision: 1,
  top: {},
  folders: [
    folder("work", null, WORK),
    folder("clients", "work", null),
    folder("northwind", "clients", NORTHWIND),
    folder("ops", null, null, ACME),
  ],
  threadHomes: [],
  projectHomes: [],
  pools: { top: null, folders: [] },
};

const block = (
  name: string,
  source: AutomationBlockLibraryEntry["source"],
  availability: Partial<AutomationBlockLibraryEntry["availability"]> = {},
): AutomationBlockLibraryEntry => ({
  name,
  description: null,
  source,
  availability: { enabled: true, hasLiveVersion: true, runtimeMode: null, ...availability },
});

describe("blockLibraryTargets", () => {
  it("offers each owner's top level and only folders with files, with their chains", () => {
    const targets = blockLibraryTargets(ENV, contexts, snapshot);
    expect(targets.map((target) => [target.key, target.label, target.projectId])).toEqual([
      ["cloud:top:personal", "Top level", SCRATCH],
      ["cloud:folder:work", "Top level / Work", WORK],
      ["cloud:folder:northwind", "Top level / Work / Clients / Northwind", NORTHWIND],
      ["cloud:top:org:acme", "Acme", ACME_FILES],
    ]);
    // Nearest first, skipping Clients, which has no files and so no blocks.
    expect(targets[2]!.ancestors).toEqual([
      { projectId: WORK, label: "Top level / Work", kind: "folder" },
      { projectId: SCRATCH, label: "Top level", kind: "top" },
    ]);
    expect(targets[0]!.ancestors).toEqual([]);
  });

  it("leaves out an owner without files of its own", () => {
    const filesless: SignalboxContextsSnapshot = {
      contexts: [{ id: ACME, kind: "organization", name: "Acme", projectIds: [] }],
    };
    expect(blockLibraryTargets(ENV, filesless, snapshot)).toEqual([]);
  });
});

describe("groupBlockLibrary", () => {
  const northwind = blockLibraryTargets(ENV, contexts, snapshot)[2]!;

  it("groups winners nearest first, then built-ins, then sources it can't place", () => {
    const groups = groupBlockLibrary(northwind, [
      block("Triage", { type: "builtin", slug: "triage" }),
      block("Zeta", { type: "folder", projectId: NORTHWIND }),
      block("Deploy", { type: "folder", projectId: SCRATCH }),
      block("Alpha", { type: "folder", projectId: NORTHWIND }),
      block("Mystery", { type: "folder", projectId: ProjectId.make("drive:gone") }),
      block("Review", { type: "folder", projectId: WORK }),
    ]);
    expect(
      groups.map((group) => [group.kind, group.title, group.blocks.map((entry) => entry.name)]),
    ).toEqual([
      ["here", "Top level / Work / Clients / Northwind", ["Alpha", "Zeta"]],
      ["folder", "Top level / Work", ["Review"]],
      ["top", "Top level", ["Deploy"]],
      ["builtin", "Built-in", ["Triage"]],
      ["unknown", "Other levels", ["Mystery"]],
    ]);
  });

  it("shows nothing for a level with no blocks", () => {
    expect(groupBlockLibrary(northwind, [])).toEqual([]);
  });
});
