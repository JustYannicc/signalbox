/** Thread status lines (#670): the agent's notes, per Signalbox Cloud environment. See the web twin. */
import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { createSignalboxThreadStatusAtoms } from "@t3tools/client-runtime/state/signalboxThreadStatus";
import type { ThreadStatusNotes } from "@t3tools/client-runtime/state/threadStatusLine";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadStatusNote } from "@t3tools/contracts/signalboxStatusLine";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { environmentServerConfigsAtom } from "./server";

const signalboxThreadStatus = createSignalboxThreadStatusAtoms(connectionAtomRuntime);

const NO_NOTES: ThreadStatusNotes = new Map();

/** Whether the environment keeps status notes. Only Signalbox Cloud does. */
export function useEnvironmentHasStatusNotes(environmentId: EnvironmentId | null): boolean {
  return (
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.threadStatusNotes === true
  );
}

/**
 * The environment's notes, empty where it doesn't keep them or they haven't
 * arrived. Subscribes only where the capability is advertised.
 */
const environmentStatusNotesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ThreadStatusNotes => {
    const config = get(environmentServerConfigsAtom).get(environmentId);
    if (config?.environment.capabilities.threadStatusNotes !== true) return NO_NOTES;
    const notes = get(signalboxThreadStatus.notes({ environmentId, input: {} }));
    return Option.getOrNull(AsyncResult.value(notes)) ?? NO_NOTES;
  }).pipe(Atom.withLabel(`signalbox-thread-status-notes:${environmentId}`)),
);

/**
 * One thread's note. A changed note replaces only its own entry in the map,
 * so a row reading this re-renders when its note changes, not on every note.
 */
const threadStatusNoteAtom = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make(
    (get): ThreadStatusNote | null =>
      get(environmentStatusNotesAtom(ref.environmentId)).get(ref.threadId) ?? null,
  ).pipe(Atom.withLabel(`signalbox-thread-status-note:${key}`));
});

/** The thread's note, or null where none was written or the environment keeps none. */
export function useThreadStatusNote(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadStatusNote | null {
  return useAtomValue(threadStatusNoteAtom(threadKey({ environmentId, threadId })));
}
