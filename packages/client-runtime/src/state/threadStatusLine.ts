import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import type { FolderId, SignalboxFoldersSnapshot } from "@t3tools/contracts/signalboxFolders";
import type {
  SignalboxThreadStatusStreamItem,
  ThreadStatusNote,
} from "@t3tools/contracts/signalboxStatusLine";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

import { threadHomeLookup, type ThreadRef } from "./foldersModel.ts";

/**
 * A thread's status line (#670): what's going on and what has to happen next,
 * readable by someone who has never seen the thread. Code sets the state and
 * what it waits on from the shell, so they follow the thread live; the agent's
 * note (`signalboxStatusLine.ts`) carries the next step and where it got to.
 *
 * Pure, so the cloud answers agents with the same line people see.
 */

/**
 * Considering and Ready join with task states (#671) and asks (#667). Idle is
 * a thread nothing runs on and nothing waits for: a chat after its answer, or
 * a task between turns.
 */
export type ThreadStatusState =
  | "working"
  | "waiting_on_person"
  | "waiting_on_other"
  | "idle"
  | "archived";

export type ThreadWaitingOn =
  /** The thread's people: the last turn failed, or the agent asked or needs approval. */
  | { readonly kind: "person"; readonly reason: "failed" | "input" | "approval" }
  /** Work outside the thread: an automation watching CI, a pull request, a wait. */
  | { readonly kind: "work"; readonly label: string }
  /** A time: the provider's usage limit resets. */
  | { readonly kind: "limit"; readonly resetsAt: string };

export interface ThreadStatusLine {
  readonly state: ThreadStatusState;
  readonly waitingOn: ThreadWaitingOn | null;
  /** Archived only: it was settled rather than archived. */
  readonly settled: boolean;
  /** The agent's note; null until one was written. */
  readonly note: ThreadStatusNote | null;
}

export type StatusShell = Pick<
  OrchestrationV2ThreadShell,
  | "status"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "limitRecovery"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "settledAt"
>;

const WORKING_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** The code half of the line, from the shell alone. */
export function threadStatusOf(shell: StatusShell): {
  readonly state: ThreadStatusState;
  readonly waitingOn: ThreadWaitingOn | null;
  readonly settled: boolean;
} {
  const settled =
    shell.settledOverride === "settled" ||
    (shell.settledAt !== null && shell.settledOverride !== "active");
  if (shell.archivedAt !== null || shell.deletedAt !== null) {
    return { state: "archived", waitingOn: null, settled: false };
  }
  const request = shell.pendingRuntimeRequest;
  if (request !== null && request.kind !== "auth_refresh") {
    return {
      state: "waiting_on_person",
      waitingOn: { kind: "person", reason: request.kind === "user_input" ? "input" : "approval" },
      settled: false,
    };
  }
  const tasks = shell.pendingBackgroundTasks ?? [];
  const monitor = tasks.find((task) => task.kind === "monitor");
  const runStatus = shell.activityRunStatus ?? shell.status;
  if (WORKING_RUN_STATUSES.has(runStatus)) {
    return { state: "working", waitingOn: null, settled: false };
  }
  if (shell.status === "failed") {
    return {
      state: "waiting_on_person",
      waitingOn: { kind: "person", reason: "failed" },
      settled: false,
    };
  }
  const limit = shell.limitRecovery;
  if (limit != null) {
    return {
      state: "waiting_on_other",
      waitingOn: { kind: "limit", resetsAt: limit.resetAt },
      settled: false,
    };
  }
  if (monitor !== undefined) {
    return {
      state: "waiting_on_other",
      waitingOn: { kind: "work", label: monitor.description ?? "an automation" },
      settled: false,
    };
  }
  // A subagent or background task still running keeps the thread at work.
  if (backgroundWorkHoldsCompletion(tasks)) {
    return { state: "working", waitingOn: null, settled: false };
  }
  if (settled) return { state: "archived", waitingOn: null, settled: true };
  return { state: "idle", waitingOn: null, settled: false };
}

export function threadStatusLine(
  shell: StatusShell,
  note: ThreadStatusNote | null | undefined,
): ThreadStatusLine {
  return { ...threadStatusOf(shell), note: note ?? null };
}

/** The state in a few words, the way the line leads with it. */
export function threadStatusHeadline(
  line: Pick<ThreadStatusLine, "state" | "waitingOn" | "settled">,
): string {
  switch (line.state) {
    case "working":
      return "Working";
    case "idle":
      return "Idle";
    case "archived":
      return line.settled ? "Settled" : "Archived";
    case "waiting_on_person":
      switch (line.waitingOn?.kind === "person" ? line.waitingOn.reason : undefined) {
        case "failed":
          return "Waiting on you: the last turn failed";
        case "input":
          return "Waiting on you: it asked something";
        case "approval":
          return "Waiting on you: it needs an approval";
        default:
          return "Waiting on you";
      }
    case "waiting_on_other":
      if (line.waitingOn?.kind === "limit") return "Waiting for the usage limit to reset";
      if (line.waitingOn?.kind === "work") return `Waiting on ${lowerFirst(line.waitingOn.label)}`;
      return "Waiting";
  }
}

const lowerFirst = (text: string) =>
  /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;

// ── Notes stream ────────────────────────────────────────────────────────

export type ThreadStatusNotes = ReadonlyMap<ThreadId, ThreadStatusNote>;

/** Folds the notes stream: a snapshot replaces everything, a note replaces its thread's. */
export function applyThreadStatusItem(
  notes: ThreadStatusNotes,
  item: SignalboxThreadStatusStreamItem,
): ThreadStatusNotes {
  if (item._tag === "snapshot") {
    return new Map(item.notes.map((entry) => [entry.threadId, entry.note]));
  }
  const current = notes.get(item.threadId);
  if (
    current !== undefined &&
    DateTime.toEpochMillis(current.writtenAt) > DateTime.toEpochMillis(item.note.writtenAt)
  ) {
    return notes;
  }
  const next = new Map(notes);
  next.set(item.threadId, item.note);
  return next;
}

// ── Folder roll-up ──────────────────────────────────────────────────────

export interface FolderStatusCounts {
  readonly working: number;
  /** Waiting on a person or on something else: the roll-up never says who. */
  readonly waiting: number;
  readonly idle: number;
}

/** One thread that matters most in a folder, for whoever asks what's going on there. */
export interface FolderStatusHighlight {
  readonly threadId: ThreadId;
  readonly reason: "oldest_waiting_on_person";
  /** When it started waiting, as far as the shell knows: its last change. */
  readonly since: string;
}

export interface FolderStatusRollup {
  readonly counts: FolderStatusCounts;
  /** At most two, most important first. Never shown passively: chat-level signals are pulled. */
  readonly highlights: ReadonlyArray<FolderStatusHighlight>;
}

export type StatusResident = ThreadRef & {
  readonly state: ThreadStatusState;
  /** ISO time of the thread's last change. */
  readonly updatedAt: string;
};

const EMPTY_COUNTS: FolderStatusCounts = { working: 0, waiting: 0, idle: 0 };

/**
 * Every folder's roll-up, counting the threads at home in it or anywhere
 * below, like `folderThreadCounts`. Archived threads don't count. Folders with
 * no live thread have no entry.
 */
export function folderStatusRollups(
  snapshot: SignalboxFoldersSnapshot,
  residents: ReadonlyArray<StatusResident>,
): ReadonlyMap<FolderId, FolderStatusRollup> {
  const homeOf = threadHomeLookup(snapshot);
  const parentOf = new Map(snapshot.folders.map((folder) => [folder.id, folder.parentId]));
  const counts = new Map<FolderId, FolderStatusCounts>();
  const waitingOnPerson = new Map<FolderId, Array<StatusResident>>();
  for (const thread of residents) {
    if (thread.state === "archived") continue;
    const seen = new Set<FolderId>();
    for (let id = homeOf(thread); id !== null && !seen.has(id); id = parentOf.get(id) ?? null) {
      seen.add(id);
      const current = counts.get(id) ?? EMPTY_COUNTS;
      counts.set(id, {
        working: current.working + (thread.state === "working" ? 1 : 0),
        waiting:
          current.waiting +
          (thread.state === "waiting_on_person" || thread.state === "waiting_on_other" ? 1 : 0),
        idle: current.idle + (thread.state === "idle" ? 1 : 0),
      });
      if (thread.state === "waiting_on_person") {
        const list = waitingOnPerson.get(id) ?? [];
        list.push(thread);
        waitingOnPerson.set(id, list);
      }
    }
  }
  const rollups = new Map<FolderId, FolderStatusRollup>();
  for (const [folderId, folderCounts] of counts) {
    const oldest = (waitingOnPerson.get(folderId) ?? [])
      .toSorted((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
      .slice(0, 2);
    rollups.set(folderId, {
      counts: folderCounts,
      highlights: oldest.map((thread) => ({
        threadId: thread.id,
        reason: "oldest_waiting_on_person",
        since: thread.updatedAt,
      })),
    });
  }
  return rollups;
}

/**
 * The roll-up as one quiet line: "2 working · 1 waiting". Idle threads stay
 * out, and a folder where nothing moves says nothing (null), so the line only
 * appears when there's progress to report.
 */
export function folderStatusSummary(counts: FolderStatusCounts): string | null {
  const parts = [
    counts.working > 0 ? `${counts.working} working` : null,
    counts.waiting > 0 ? `${counts.waiting} waiting` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}
