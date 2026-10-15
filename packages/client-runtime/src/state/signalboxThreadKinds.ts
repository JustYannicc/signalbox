import {
  SIGNALBOX_THREAD_KINDS_WS_METHODS,
  type SignalboxThreadKindsSnapshot,
  type ThreadKind,
  type ThreadKindRecord,
} from "@t3tools/contracts/signalboxThreadKinds";
import type { ThreadId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long an idle chat has left before it archives itself ("in 3d", "in
 * 5h", "in 20m", or "soon" once it's due and the sweep hasn't run yet).
 * `lastDay`: under a day left, the only time a row shows it.
 */
export function chatArchiveCountdown(
  dueAtMs: number,
  nowMs: number,
): { readonly remaining: string; readonly lastDay: boolean } {
  const remainingMs = dueAtMs - nowMs;
  if (remainingMs <= 0) return { remaining: "soon", lastDay: true };
  if (remainingMs < HOUR_MS) {
    return { remaining: `in ${Math.max(1, Math.ceil(remainingMs / 60_000))}m`, lastDay: true };
  }
  if (remainingMs < DAY_MS) {
    return { remaining: `in ${Math.ceil(remainingMs / HOUR_MS)}h`, lastDay: true };
  }
  return { remaining: `in ${Math.ceil(remainingMs / DAY_MS)}d`, lastDay: false };
}
