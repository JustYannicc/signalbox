// signalbox: the words chat and task kinds show with (#46).
import {
  chatArchiveCountdown,
  otherThreadKind,
} from "@t3tools/client-runtime/state/signalboxThreadKinds";
import type { ThreadKind } from "@t3tools/contracts/signalboxThreadKinds";

import { formatElapsedDurationLabel } from "../../timestampFormat";

export const THREAD_KIND_LABEL: Record<ThreadKind, string> = { chat: "Chat", task: "Task" };

/** What the sidebar's Undo says after a flip (`showThreadUndoNotice`). */
export type ThreadKindUndoAction = "Made a chat" | "Made a task";

/** The undoable action a flip to each kind is. */
export const THREAD_KIND_UNDO_ACTION: Record<ThreadKind, ThreadKindUndoAction> = {
  chat: "Made a chat",
  task: "Made a task",
};

const KIND_BY_UNDO_ACTION: Record<ThreadKindUndoAction, ThreadKind> = {
  "Made a chat": "chat",
  "Made a task": "task",
};

/** What a failed flip to each kind says. */
export const THREAD_KIND_FLIP_FAILURE: Record<ThreadKind, string> = {
  chat: "Could not make it a chat",
  task: "Could not make it a task",
};

export function isThreadKindUndoAction(action: string): action is ThreadKindUndoAction {
  return Object.hasOwn(KIND_BY_UNDO_ACTION, action);
}

/** "Made 1 thread a task", "Made 3 threads chats". */
export function threadKindUndoText(action: ThreadKindUndoAction, count: number): string {
  const kind = KIND_BY_UNDO_ACTION[action];
  return count === 1 ? `Made 1 thread a ${kind}` : `Made ${count} threads ${kind}s`;
}

interface KindFacts {
  readonly kind: ThreadKind;
  readonly switchedByWork: boolean;
  readonly workStartedAt: string | null;
  readonly archiveDueAtMs: number | null;
}

/**
 * What a thread's kind adds beyond its name: when a chat archives itself
 * ("archives in 3d"), or why a chat became a task ("started editing files
 * 2h ago"). Null when there's nothing to add.
 */
export function threadKindDetail(facts: KindFacts, nowMs: number): string | null {
  if (facts.kind === "chat") {
    if (facts.archiveDueAtMs === null) return null;
    return `archives ${chatArchiveCountdown(facts.archiveDueAtMs, nowMs).remaining}`;
  }
  if (!facts.switchedByWork) return null;
  const elapsed =
    facts.workStartedAt === null ? "" : formatElapsedDurationLabel(facts.workStartedAt, nowMs);
  if (elapsed === "") return "started editing files";
  return `started editing files ${elapsed === "just now" ? elapsed : `${elapsed} ago`}`;
}

/** One line on what a thread is: "Chat, archives in 3d", or just "Task". */
export function threadKindSummary(facts: KindFacts, nowMs: number): string {
  const detail = threadKindDetail(facts, nowMs);
  return detail === null
    ? THREAD_KIND_LABEL[facts.kind]
    : `${THREAD_KIND_LABEL[facts.kind]}, ${detail}`;
}

/** The click's promise: "Make it a task". */
export function threadKindFlipLabel(kind: ThreadKind): string {
  return `Make it a ${otherThreadKind(kind)}`;
}

/**
 * Replaces a row's age only on a chat's last idle day ("Archives in 5h"),
 * so rows stay calm the rest of the week. Null: show the age.
 */
export function chatArchiveRowLabel(archiveDueAtMs: number | null, nowMs: number): string | null {
  if (archiveDueAtMs === null) return null;
  const countdown = chatArchiveCountdown(archiveDueAtMs, nowMs);
  return countdown.lastDay ? `Archives ${countdown.remaining}` : null;
}

const LEAVE_LABEL: Record<ThreadKind, "Done" | "Archive"> = { chat: "Archive", task: "Done" };

/** How a thread leaves the list: a task is Done, anything else is archived. Both archive. */
export function threadLeaveLabel(kind: ThreadKind | null): "Done" | "Archive" {
  return kind === null ? "Archive" : LEAVE_LABEL[kind];
}

const ARCHIVE_CHATS_AFTER_DAYS_CHOICES: ReadonlyArray<number> = [1, 3, 7, 14, 30];

/**
 * Settings → Archive idle chats after: a few day counts and Never, plus
 * whatever count an environment already has, in order.
 */
export function archiveChatsAfterDaysChoices(current: number | null): ReadonlyArray<number | null> {
  const days =
    current === null || ARCHIVE_CHATS_AFTER_DAYS_CHOICES.includes(current)
      ? ARCHIVE_CHATS_AFTER_DAYS_CHOICES
      : [...ARCHIVE_CHATS_AFTER_DAYS_CHOICES, current].toSorted((a, b) => a - b);
  return [...days, null];
}

export function archiveChatsAfterDaysLabel(days: number | null): string {
  if (days === null) return "Never";
  return days === 1 ? "1 day" : `${days} days`;
}
