import {
  SIGNALBOX_THREAD_KINDS_WS_METHODS,
  type SignalboxThreadKindsSnapshot,
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
