import { ProjectId, RunId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import { FolderId, type SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import type { ThreadStatusNote } from "@t3tools/contracts/signalboxStatusLine";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  applyThreadStatusItem,
  folderStatusRollups,
  folderStatusSummary,
  type StatusShell,
  type ThreadStatusState,
  threadStatusHeadline,
  threadStatusOf,
} from "./threadStatusLine.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const idle: StatusShell = {
  status: "completed",
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  limitRecovery: null,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  settledAt: null,
};

const headline = (shell: Partial<StatusShell>) =>
  threadStatusHeadline(threadStatusOf({ ...idle, ...shell }));

describe("threadStatusOf", () => {
  it("says a thread between turns is idle", () => {
    expect(threadStatusOf(idle)).toEqual({ state: "idle", waitingOn: null, settled: false });
    expect(headline({ status: "interrupted" })).toBe("Idle");
  });

  it("follows a live run as working", () => {
    expect(headline({ status: "running", activityRunStatus: "running" })).toBe("Working");
    expect(headline({ status: "queued" })).toBe("Working");
    // A subagent still running keeps it at work after its own turn ended.
    expect(headline({ pendingBackgroundTasks: [{ kind: "subagent", taskId: "task-1" }] })).toBe(
      "Working",
    );
  });

  it("waits on a person for a failed turn or an open question", () => {
    expect(headline({ status: "failed" })).toBe("Waiting on you: the last turn failed");
    expect(
      headline({
        status: "running",
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("request-1"),
          kind: "user_input",
          createdAt: at("2026-10-16T10:00:00Z"),
        },
      }),
    ).toBe("Waiting on you: it asked something");
  });

  it("names what else it waits on", () => {
    expect(
      headline({
        pendingBackgroundTasks: [
          { kind: "monitor", taskId: "watch", description: "PR #12 checks" },
        ],
      }),
    ).toBe("Waiting on PR #12 checks");
    expect(
      threadStatusOf({
        ...idle,
        limitRecovery: {
          runId: RunId.make("run-1"),
          resetAt: "2026-10-16T12:00:00.000Z",
          autoResume: true,
        },
      }).waitingOn,
    ).toEqual({ kind: "limit", resetsAt: "2026-10-16T12:00:00.000Z" });
  });

  it("archives archived and settled threads, telling them apart", () => {
    expect(headline({ archivedAt: at("2026-10-16T10:00:00Z") })).toBe("Archived");
    expect(headline({ settledOverride: "settled" })).toBe("Settled");
    expect(headline({ settledAt: at("2026-10-16T10:00:00Z"), settledOverride: "active" })).toBe(
      "Idle",
    );
  });
});

const note = (nextStep: string, writtenAt: string): ThreadStatusNote => ({
  nextStep,
  whereItGotTo: "It got somewhere.",
  writtenAt: at(writtenAt),
  writtenBy: "agent",
  runId: null,
});

describe("applyThreadStatusItem", () => {
  const thread = ThreadId.make("thread-1");

  it("replaces everything on a snapshot and one thread on a note", () => {
    const first = applyThreadStatusItem(new Map(), {
      _tag: "snapshot",
      notes: [{ threadId: thread, note: note("Review the PR", "2026-10-16T10:00:00Z") }],
    });
    const next = applyThreadStatusItem(first, {
      _tag: "note",
      threadId: thread,
      note: note("Merge it", "2026-10-16T11:00:00Z"),
    });
    expect(next.get(thread)?.nextStep).toBe("Merge it");
    expect(first.get(thread)?.nextStep).toBe("Review the PR");
  });

  it("keeps a newer note over a late older one", () => {
    const current = new Map([[thread, note("Merge it", "2026-10-16T11:00:00Z")]]);
    const next = applyThreadStatusItem(current, {
      _tag: "note",
      threadId: thread,
      note: note("Review the PR", "2026-10-16T10:00:00Z"),
    });
    expect(next).toBe(current);
  });
});

describe("folderStatusRollups", () => {
  const PERSONAL = SignalboxContextId.make("personal");
  const DRIVE = ProjectId.make("drive:work");
  const SCRATCH = ProjectId.make("scratch");
  const work = FolderId.make("work");
  const clients = FolderId.make("clients");
  const snapshot: SignalboxFoldersSnapshot = {
    revision: 1,
    top: {},
    folders: [
      { id: work, name: "Work", parentId: null, position: 0, ownerId: PERSONAL },
      { id: clients, name: "Clients", parentId: work, position: 0, ownerId: PERSONAL },
    ],
    threadHomes: [{ threadId: ThreadId.make("filed"), folderId: clients }],
    projectHomes: [
      { projectId: DRIVE, folderId: work },
      { projectId: SCRATCH, folderId: null },
    ],
    pools: { top: null, folders: [] },
  };
  const resident = (
    id: string,
    projectId: ProjectId,
    state: ThreadStatusState,
    updatedAt: string,
  ) => ({
    id: ThreadId.make(id),
    projectId,
    state,
    updatedAt,
  });

  it("counts threads in a folder and every folder above it, leaving archived out", () => {
    const rollups = folderStatusRollups(snapshot, [
      resident("filed", SCRATCH, "waiting_on_person", "2026-10-16T09:00:00Z"),
      resident("a", DRIVE, "working", "2026-10-16T10:00:00Z"),
      resident("b", DRIVE, "idle", "2026-10-16T10:00:00Z"),
      resident("c", DRIVE, "archived", "2026-10-16T10:00:00Z"),
      resident("top", SCRATCH, "working", "2026-10-16T10:00:00Z"),
    ]);
    expect(rollups.get(clients)?.counts).toEqual({ working: 0, waiting: 1, idle: 0 });
    expect(rollups.get(work)?.counts).toEqual({ working: 1, waiting: 1, idle: 1 });
    expect(rollups.get(work)?.highlights).toEqual([
      {
        threadId: ThreadId.make("filed"),
        reason: "oldest_waiting_on_person",
        since: "2026-10-16T09:00:00Z",
      },
    ]);
  });

  it("highlights at most the two oldest waits on a person", () => {
    const rollups = folderStatusRollups(snapshot, [
      resident("new", DRIVE, "waiting_on_person", "2026-10-16T12:00:00Z"),
      resident("old", DRIVE, "waiting_on_person", "2026-10-16T08:00:00Z"),
      resident("mid", DRIVE, "waiting_on_person", "2026-10-16T10:00:00Z"),
    ]);
    expect(rollups.get(work)?.highlights.map((item) => item.threadId)).toEqual([
      ThreadId.make("old"),
      ThreadId.make("mid"),
    ]);
  });
});

describe("folderStatusSummary", () => {
  it("reports only movement, and nothing for a quiet folder", () => {
    expect(folderStatusSummary({ working: 2, waiting: 1, idle: 4 })).toBe("2 working · 1 waiting");
    expect(folderStatusSummary({ working: 0, waiting: 3, idle: 0 })).toBe("3 waiting");
    expect(folderStatusSummary({ working: 0, waiting: 0, idle: 4 })).toBeNull();
  });
});
