/**
 * signalbox: threads' chat and task kinds (#46), per environment that keeps
 * them (`capabilities.threadKinds`). Everywhere else a thread shows no kind
 * at all.
 */
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  createSignalboxThreadKindsAtoms,
  otherThreadKind,
  threadKindLookup,
} from "@t3tools/client-runtime/state/signalboxThreadKinds";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import {
  chatArchiveDueAtMs,
  effectiveThreadKind,
  type ArchiveChatsAfterDays,
  type SignalboxThreadKindsSnapshot,
  type ThreadKind,
} from "@t3tools/contracts/signalboxThreadKinds";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { showThreadUndoNotice } from "../hooks/showThreadUndoNotice";
import * as ThreadUndo from "../hooks/threadUndo";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./server";

export const signalboxThreadKinds = createSignalboxThreadKindsAtoms(connectionAtomRuntime);

/** An environment's kinds: null when it doesn't keep them, or they haven't arrived yet. */
export const environmentThreadKindsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): SignalboxThreadKindsSnapshot | null => {
    const supported =
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities.threadKinds ===
      true;
    if (!supported) return null;
    const result = get(signalboxThreadKinds.snapshot({ environmentId, input: {} }));
    return Option.getOrNull(AsyncResult.value(result));
  }).pipe(Atom.withLabel(`web-thread-kinds:${environmentId}`)),
);

/** What a thread's row needs from its record, unchanged until one of these changes. */
interface ThreadKindView {
  readonly kind: ThreadKind;
  readonly switchedByWork: boolean;
  readonly workStartedAt: string | null;
  readonly archiveChatsAfterDays: ArchiveChatsAfterDays;
}

const threadKindViewAtom = Atom.family((threadKey: string) =>
  Atom.make((get): ThreadKindView | null => {
    const ref = parseScopedThreadKey(threadKey);
    if (ref === null) return null;
    const snapshot = get(environmentThreadKindsAtom(ref.environmentId));
    if (snapshot === null) return null;
    const record = threadKindLookup(snapshot)(ref.threadId);
    const { kind, switchedByWork } = effectiveThreadKind(record);
    const workStartedAt =
      record?.workStartedAt == null ? null : DateTime.formatIso(record.workStartedAt);
    const previous = Option.getOrUndefined(get.self<ThreadKindView | null>());
    return previous?.kind === kind &&
      previous.switchedByWork === switchedByWork &&
      previous.workStartedAt === workStartedAt &&
      previous.archiveChatsAfterDays === snapshot.archiveChatsAfterDays
      ? previous
      : {
          kind,
          switchedByWork,
          workStartedAt,
          archiveChatsAfterDays: snapshot.archiveChatsAfterDays,
        };
  }).pipe(Atom.withLabel(`web-thread-kind:${threadKey}`)),
);

/**
 * Flips not yet back from the server, by thread key. A row shows them at
 * once, and drops them when the server agrees or the flip fails.
 */
const usePendingThreadKinds = create<{ readonly pending: Readonly<Record<string, ThreadKind>> }>(
  () => ({ pending: {} }),
);

function setPending(threadKey: string, kind: ThreadKind | null) {
  usePendingThreadKinds.setState(({ pending }) => {
    if (kind === null) {
      if (!(threadKey in pending)) return { pending };
      const { [threadKey]: _dropped, ...rest } = pending;
      return { pending: rest };
    }
    return pending[threadKey] === kind
      ? { pending }
      : { pending: { ...pending, [threadKey]: kind } };
  });
}

/** A thread's kind as its row shows it. */
export interface ThreadKindState {
  readonly threadRef: ScopedThreadRef;
  readonly kind: ThreadKind;
  /** Classified a chat, became a task because a turn changed files; the user hasn't flipped it. */
  readonly switchedByWork: boolean;
  readonly workStartedAt: string | null;
  /** When this chat archives itself; null for tasks and when chats never do. */
  readonly archiveDueAtMs: number | null;
  /** This connection may flip it. */
  readonly canChange: boolean;
}

/**
 * The kind of one thread, or null where its environment keeps none (no kind
 * UI at all there). `updatedAt` is the thread shell's: a chat's idle clock.
 */
export function useThreadKind(
  threadRef: ScopedThreadRef,
  updatedAt: string,
): ThreadKindState | null {
  const threadKey = scopedThreadKey(threadRef);
  const view = useAtomValue(threadKindViewAtom(threadKey));
  const pending = usePendingThreadKinds((state) => state.pending[threadKey]);
  const canChange = useAtomValue(
    signalboxThreadKinds.setKind.permissionAtom(threadRef.environmentId),
  );
  useEffect(() => {
    if (pending !== undefined && view?.kind === pending) setPending(threadKey, null);
  }, [pending, threadKey, view?.kind]);
  const { environmentId, threadId } = threadRef;
  return useMemo(() => {
    if (view === null) return null;
    const kind = pending ?? view.kind;
    const switchedByWork = kind === view.kind && view.switchedByWork;
    const updatedAtMs = Date.parse(updatedAt);
    return {
      threadRef: { environmentId, threadId },
      kind,
      switchedByWork,
      workStartedAt: switchedByWork ? view.workStartedAt : null,
      archiveDueAtMs:
        kind === "chat" && !Number.isNaN(updatedAtMs)
          ? chatArchiveDueAtMs(updatedAtMs, view.archiveChatsAfterDays)
          : null,
      canChange,
    };
  }, [canChange, environmentId, pending, threadId, updatedAt, view]);
}

/** A thread's kind right now, for menus built at open time; null where none is kept. */
export function readThreadKind(threadRef: ScopedThreadRef): ThreadKind | null {
  const threadKey = scopedThreadKey(threadRef);
  const view = appAtomRegistry.get(threadKindViewAtom(threadKey));
  if (view === null) return null;
  return usePendingThreadKinds.getState().pending[threadKey] ?? view.kind;
}

export function readCanChangeThreadKind(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(signalboxThreadKinds.setKind.permissionAtom(environmentId));
}

/** Makes a thread `kind`, showing it at once. */
async function setThreadKind(
  threadRef: ScopedThreadRef,
  kind: ThreadKind,
): Promise<AtomCommandResult<unknown, unknown>> {
  const threadKey = scopedThreadKey(threadRef);
  setPending(threadKey, kind);
  const result = await runAtomCommand(
    appAtomRegistry,
    signalboxThreadKinds.setKind,
    { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId, kind } },
    { reportFailure: false },
  );
  if (result._tag === "Failure") setPending(threadKey, null);
  return result;
}

/**
 * Turns a chat into a task or back, with Undo in the sidebar. The server
 * drops the user's flip when the thread is back to what it would be anyway.
 */
export async function flipThreadKind(threadRef: ScopedThreadRef, from: ThreadKind): Promise<void> {
  const to = otherThreadKind(from);
  const claim = ThreadUndo.begin("kind", scopedThreadKey(threadRef));
  const result = await setThreadKind(threadRef, to);
  if (result._tag === "Failure") {
    claim.finish();
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: to === "task" ? "Could not make it a task" : "Could not make it a chat",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
    return;
  }
  showThreadUndoNotice({
    action: to === "task" ? "Made a task" : "Made a chat",
    claim,
    undo: () => setThreadKind(threadRef, from),
    failureTitle: "Failed to undo",
  });
}

/** Saves how long chats may idle before archiving themselves, on one environment. */
export function setArchiveChatsAfterDays(
  environmentId: EnvironmentId,
  days: ArchiveChatsAfterDays,
) {
  return runAtomCommand(
    appAtomRegistry,
    signalboxThreadKinds.setArchiveChatsAfterDays,
    { environmentId, input: { days } },
    { reportFailure: false },
  );
}
