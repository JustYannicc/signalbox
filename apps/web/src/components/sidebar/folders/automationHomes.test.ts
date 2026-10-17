import { type Automation, EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  SignalboxContextId,
  type SignalboxContextsSnapshot,
} from "@t3tools/contracts/signalboxContexts";
import { FolderId, type SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import { describe, expect, it } from "vite-plus/test";

import { attentionRunId, folderAutomationLists, sameAutomationRows } from "./automationHomes";
import { folderOwners, folderThreadListKey, homeLabel } from "./folderSidebarModel";

const ENV = EnvironmentId.make("cloud");
const PERSONAL = SignalboxContextId.make("personal");
const ACME = SignalboxContextId.make("org_acme");
const SCRATCH = ProjectId.make("scratch");
const SIGNALBOX_REPO = ProjectId.make("github:signalbox");
const ACME_FILES = ProjectId.make("context:org_acme");
const ELSEWHERE = ProjectId.make("not-an-owners");
const DEV = FolderId.make("dev");
const SIGNALBOX = FolderId.make("signalbox");

const contexts: SignalboxContextsSnapshot = {
  contexts: [
    { id: PERSONAL, kind: "personal", name: "Personal", projectIds: [SCRATCH, SIGNALBOX_REPO] },
    { id: ACME, kind: "organization", name: "Acme", projectIds: [ACME_FILES] },
  ],
};

/** Personal: Dev › signalbox, which has the repository as its files. */
const snapshot: SignalboxFoldersSnapshot = {
  revision: 1,
  top: {},
  folders: [
    { id: DEV, name: "Dev", parentId: null, position: 0, ownerId: PERSONAL },
    {
      id: SIGNALBOX,
      name: "signalbox",
      parentId: DEV,
      position: 0,
      ownerId: PERSONAL,
      files: { projectId: SIGNALBOX_REPO },
    },
  ],
  threadHomes: [],
  projectHomes: [
    { projectId: SCRATCH, folderId: null },
    { projectId: SIGNALBOX_REPO, folderId: SIGNALBOX },
  ],
  pools: { top: null, folders: [] },
};

const owners = folderOwners(contexts, snapshot);

const automation = (
  name: string,
  projectId: ProjectId,
  overrides: Partial<Automation> = {},
): Automation => ({
  id: name,
  name,
  description: null,
  intent: null,
  enabled: true,
  version: 1,
  draftVersion: null,
  projectId,
  triggers: [],
  nextRunAt: null,
  webhook: null,
  createdAt: "2026-10-17T00:00:00.000Z",
  updatedAt: "2026-10-17T00:00:00.000Z",
  lastRun: null,
  waiting: [],
  ...overrides,
});

const failedRun = {
  id: "run-failed",
  automationId: "x",
  version: 1,
  status: "failed",
  trigger: "cron",
  startedAt: "2026-10-17T06:41:00.000Z",
  finishedAt: "2026-10-17T06:45:00.000Z",
  error: "boom",
  errorDetail: null,
  waitingOnYou: false,
  title: null,
  retryOf: null,
} as const;

const question = {
  runId: "run-asks",
  stepKey: "ask",
  label: "Merge it?",
  question: null,
  options: ["Yes", "No"],
  multi: false,
  fields: [],
  since: "2026-10-17T12:41:00.000Z",
};

const names = (list: ReadonlyArray<Automation> | undefined) => list?.map((each) => each.name);

describe("folderAutomationLists", () => {
  it("files an automation where its project's threads live", () => {
    const lists = folderAutomationLists(ENV, owners, snapshot, [
      automation("Sync upstream", SIGNALBOX_REPO),
      automation("Water plants", SCRATCH),
      automation("Acme digest", ACME_FILES),
    ]);
    expect(names(lists.get(folderThreadListKey(ENV, PERSONAL, SIGNALBOX)))).toEqual([
      "Sync upstream",
    ]);
    expect(names(lists.get(folderThreadListKey(ENV, PERSONAL, null)))).toEqual(["Water plants"]);
    expect(names(lists.get(folderThreadListKey(ENV, ACME, null)))).toEqual(["Acme digest"]);
  });

  it("puts what needs you first, then goes by name", () => {
    const lists = folderAutomationLists(ENV, owners, snapshot, [
      automation("b quiet", SIGNALBOX_REPO),
      automation("a quiet", SIGNALBOX_REPO),
      automation("z failed", SIGNALBOX_REPO, { lastRun: failedRun }),
      automation("y asks", SIGNALBOX_REPO, { waiting: [question] }),
    ]);
    expect(names(lists.get(folderThreadListKey(ENV, PERSONAL, SIGNALBOX)))).toEqual([
      "y asks",
      "z failed",
      "a quiet",
      "b quiet",
    ]);
  });

  it("shows an automation of a project no owner holds nowhere", () => {
    const lists = folderAutomationLists(ENV, owners, snapshot, [automation("Orphan", ELSEWHERE)]);
    expect(lists.size).toBe(0);
  });
});

describe("attentionRunId", () => {
  it("opens the question first, then a failed latest run, else nothing", () => {
    expect(attentionRunId({ waiting: [question], lastRun: failedRun })).toBe("run-asks");
    expect(attentionRunId({ waiting: [], lastRun: failedRun })).toBe("run-failed");
    expect(attentionRunId({ waiting: [], lastRun: { ...failedRun, status: "succeeded" } })).toBe(
      null,
    );
  });
});

describe("homeLabel", () => {
  it("names the folder path, or the level at the top", () => {
    const personal = contexts.contexts[0]!;
    const acme = contexts.contexts[1]!;
    expect(homeLabel(snapshot, personal, SIGNALBOX)).toBe("Dev / signalbox");
    expect(homeLabel(snapshot, personal, null)).toBe("Top level");
    expect(homeLabel(snapshot, acme, null)).toBe("Acme");
  });
});

describe("sameAutomationRows", () => {
  const quiet = automation("Sync upstream", SIGNALBOX_REPO);

  it("keeps a list whose rows draw the same, even as new objects", () => {
    expect(sameAutomationRows([quiet], [{ ...quiet, updatedAt: "2026-10-17T12:41:00.000Z" }])).toBe(
      true,
    );
  });

  it("redraws when a row's attention, name or switch changes", () => {
    expect(sameAutomationRows([quiet], [{ ...quiet, lastRun: failedRun }])).toBe(false);
    expect(sameAutomationRows([quiet], [{ ...quiet, waiting: [question] }])).toBe(false);
    expect(sameAutomationRows([quiet], [{ ...quiet, name: "Renamed" }])).toBe(false);
    expect(sameAutomationRows([quiet], [{ ...quiet, enabled: false }])).toBe(false);
  });
});
