import {
  SIGNALBOX_TRASH_WS_METHODS,
  TRASH_RETENTION_DAYS,
  type TrashEntry,
  type TrashSnapshot,
} from "@t3tools/contracts/signalboxTrash";
import type { EnvironmentId } from "@t3tools/contracts";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { trashThread } from "../operations/commands.ts";
import {
  type AtomCommandResult,
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "./runtime.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Cloud environments expose Signalbox folders, threads, and Trash together. */
export function serverConfigSupportsSignalboxTrash(
  config:
    | { readonly environment: { readonly capabilities: { readonly folders?: boolean } } }
    | null
    | undefined,
): boolean {
  return config?.environment.capabilities.folders === true;
}

export type ThreadDeleteConfirmationScope = "thread" | "threads";

/** Keep thread-delete warnings aligned with the destination's actual recovery path. */
export function threadDeleteConfirmationMessage(input: {
  readonly cloud: boolean;
  readonly other: boolean;
  readonly scope: ThreadDeleteConfirmationScope;
}): string {
  if (input.cloud && input.other) {
    return `Cloud threads will move to Trash and can be restored for ${TRASH_RETENTION_DAYS} days. Threads in other environments will be permanently deleted.`;
  }
  if (input.cloud) {
    return `${input.scope === "thread" ? "This thread" : "These threads"} will move to Trash and can be restored for ${TRASH_RETENTION_DAYS} days.`;
  }
  return `This permanently clears conversation history for ${input.scope === "thread" ? "this thread" : "these threads"}.`;
}

/**
 * Signalbox Cloud's Trash (#474): recently deleted threads and folders, kept
 * restorable for 30 days. Every change answers the whole Trash; `list` is
 * fetched again after each one so every view of it agrees.
 */
export function createSignalboxTrashAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const threadScheduler = createAtomCommandScheduler();
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:signalbox-trash:list",
    tag: SIGNALBOX_TRASH_WS_METHODS.list,
    // Other clients can change Trash while its screen is closed, so remounting must fetch again.
    staleTimeMs: 0,
    idleTtlMs: 0,
  });
  // On failure too: a refused restore can still have changed an entry's status.
  const refreshList = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => registry.refresh(list({ environmentId: target.environmentId, input: {} })));
  return {
    list,
    restore: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-trash:restore",
      tag: SIGNALBOX_TRASH_WS_METHODS.restore,
      onSettled: refreshList,
    }),
    /** Deletes the given entries for good, or every entry without `ids`. */
    empty: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-trash:empty",
      tag: SIGNALBOX_TRASH_WS_METHODS.empty,
      onSettled: refreshList,
    }),
    thread: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-trash:thread",
      tag: SIGNALBOX_TRASH_WS_METHODS.thread,
      execute: (input) => trashThread(input),
      scheduler: threadScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
      },
      onSettled: refreshList,
    }),
    folder: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-trash:folder",
      tag: SIGNALBOX_TRASH_WS_METHODS.folder,
      onSettled: refreshList,
    }),
  };
}

/** What Trash shows: everything still in it, newest first. Restored and purged entries are gone. */
export function trashEntriesShown(snapshot: TrashSnapshot): ReadonlyArray<TrashEntry> {
  return snapshot.entries
    .filter((entry) => entry.status !== "restored" && entry.status !== "purged")
    .sort((left, right) => right.deletedAt - left.deletedAt || left.id.localeCompare(right.id));
}

/** Whether an entry is mid-restore or mid-purge, so the list should be fetched again shortly. */
export function trashHasPendingWork(snapshot: TrashSnapshot): boolean {
  return snapshot.entries.some(
    (entry) => entry.status === "restoring" || entry.status === "purging",
  );
}

/** Only an entry that's simply sitting in Trash can be restored or deleted for good. */
export const trashEntryIsIdle = (entry: TrashEntry) => entry.status === "trashed";

export const trashEntryRestorable = (entry: TrashEntry, now: number) =>
  trashEntryIsIdle(entry) && entry.purgeAfter > now;

/** What Trash keeps and for how long, said once above the list. */
export function trashExplanation(purgeEnabled: boolean): string {
  return purgeEnabled
    ? `Deleted threads and folders stay here for ${TRASH_RETENTION_DAYS} days, then are deleted for good. Restoring one puts it back where it was.`
    : `Deleted threads and folders can be restored for ${TRASH_RETENTION_DAYS} days. Deleting for good isn't switched on for this server yet, so nothing here is removed.`;
}

/** "Folder · 3 threads", plus when it goes for good while that's on. */
export function trashEntrySummary(entry: TrashEntry, purgeEnabled: boolean, now: number): string {
  const parts: string[] = [entry.kind === "folder" ? "Folder" : "Thread"];
  if (entry.kind === "folder") {
    const count = entry.threadIds.length;
    parts.push(count === 1 ? "1 thread" : `${count} threads`);
  }
  if (entry.status === "trashed") {
    const days = Math.ceil((entry.purgeAfter - now) / DAY_MS);
    const duration = days === 1 ? "1 day" : `${days} days`;
    parts.push(
      purgeEnabled
        ? days <= 0
          ? "Deleted for good soon"
          : `Deleted for good in ${duration}`
        : days <= 0
          ? "Restore window ended"
          : `Restorable for ${duration}`,
    );
  }
  return parts.join(" · ");
}

/** The entry's state when it isn't simply waiting in Trash; null when it is. */
export function trashEntryState(
  entry: TrashEntry,
): { readonly text: string; readonly failed: boolean } | null {
  if (entry.error !== null) return { text: entry.error, failed: true };
  if (entry.status === "restoring") return { text: "Restoring…", failed: false };
  if (entry.status === "purging") return { text: "Deleting for good…", failed: false };
  return null;
}

/** The confirmation for deleting `entries` for good; `all` when it empties the whole Trash. */
export function trashEmptyConfirmation(
  entries: ReadonlyArray<TrashEntry>,
  all: boolean,
): { readonly title: string; readonly message: string; readonly confirmText: string } {
  const only = entries.length === 1 ? entries[0] : undefined;
  const threads = entries.reduce(
    (sum, entry) => sum + (entry.kind === "folder" ? entry.threadIds.length : 1),
    0,
  );
  const what =
    only === undefined
      ? `${entries.length} items${threads > 0 ? `, with ${threads === 1 ? "1 thread" : `${threads} threads`},` : ""}`
      : only.kind === "folder"
        ? `“${only.title}” and everything in it`
        : `“${only.title}”`;
  const title = all
    ? "Empty Trash?"
    : only === undefined
      ? `Delete ${entries.length} items forever?`
      : `Delete “${only.title}” forever?`;
  return {
    title,
    message: `${what} will be deleted for good, including history and files. This can't be undone.`,
    confirmText: all ? "Empty Trash" : "Delete forever",
  };
}

/** Why a Trash change failed, in the server's words; null when it worked or was cut off. */
export function trashFailureMessage<A, E>(result: AtomCommandResult<A, E>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "Something went wrong. Try again.";
}
