import {
  chatArchiveDueAtMs,
  chatWaitsToArchive,
  SIGNALBOX_THREAD_KINDS_WS_METHODS,
  type ArchiveChatsAfterDays,
  type SignalboxThreadKindsSnapshot,
  type ThreadKind,
  type ThreadKindRecord,
} from "@t3tools/contracts/signalboxThreadKinds";
import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { snoozeWakeLabel } from "./threadSettled.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Threads' chat and task kinds, for one environment. Only environments
 * advertising `capabilities.threadKinds` serve them.
 */
export function createSignalboxThreadKindsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:signalbox-thread-kinds:snapshot",
      tag: SIGNALBOX_THREAD_KINDS_WS_METHODS.subscribe,
    }),
    setKind: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-thread-kinds:set-kind",
      tag: SIGNALBOX_THREAD_KINDS_WS_METHODS.setKind,
    }),
    setArchiveChatsAfterDays: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-thread-kinds:set-archive-chats-after-days",
      tag: SIGNALBOX_THREAD_KINDS_WS_METHODS.setArchiveChatsAfterDays,
    }),
  };
}

const lookupCache = new WeakMap<
  SignalboxThreadKindsSnapshot,
  (threadId: ThreadId) => ThreadKindRecord | undefined
>();

/** Each thread's kind record, for many rows at once. The same function for the same snapshot. */
export function threadKindLookup(
  snapshot: SignalboxThreadKindsSnapshot,
): (threadId: ThreadId) => ThreadKindRecord | undefined {
  const cached = lookupCache.get(snapshot);
  if (cached !== undefined) return cached;
  const byId = new Map(snapshot.threads.map((record) => [record.threadId, record]));
  const lookup = (threadId: ThreadId) => byId.get(threadId);
  lookupCache.set(snapshot, lookup);
  return lookup;
}

/** The kind one click turns a thread into. */
export function otherThreadKind(kind: ThreadKind): ThreadKind {
  return kind === "chat" ? "task" : "chat";
}

/**
 * When a thread's row says it archives itself: only for a chat that waits to
 * archive (`chatWaitsToArchive`, the sweep's own rule), counted from the
 * shell's last change. Null for everything else.
 */
export function threadArchiveDueAtMs(
  shell: Pick<EnvironmentThreadShell, "updatedAt" | "archivedAt" | "pinnedAt" | "runtime">,
  kind: ThreadKind,
  days: ArchiveChatsAfterDays,
): number | null {
  const waits = chatWaitsToArchive({
    kind,
    archived: shell.archivedAt !== null,
    pinned: shell.pinnedAt !== null,
    busy: shell.runtime?.activeRunId != null || threadRuntimeIsActive(shell.runtime),
  });
  const updatedAtMs = Date.parse(shell.updatedAt);
  return waits && !Number.isNaN(updatedAtMs) ? chatArchiveDueAtMs(updatedAtMs, days) : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** From when an idle chat is on its last day, the only time a row counts it down. */
export function chatArchiveLastDayStartsAtMs(dueAtMs: number): number {
  return dueAtMs - DAY_MS;
}

/**
 * How long an idle chat has left before it archives itself, in snooze's
 * units ("in 3d", "in 5h", "in 20m", or "soon" once it's due and the sweep
 * hasn't run yet). `lastDay`: a day or less left.
 */
export function chatArchiveCountdown(
  dueAtMs: number,
  nowMs: number,
): { readonly remaining: string; readonly lastDay: boolean } {
  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const left = snoozeWakeLabel(iso(dueAtMs), { now: iso(nowMs) });
  return {
    remaining: left === "now" ? "soon" : `in ${left}`,
    lastDay: nowMs > chatArchiveLastDayStartsAtMs(dueAtMs),
  };
}
