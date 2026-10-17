/**
 * signalbox: threads' status notes (#670), the agent's half of the status
 * line, per environment that keeps them (`capabilities.threadStatusNotes`).
 * Everywhere else a thread's line is the code half alone.
 */
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createSignalboxThreadStatusAtoms } from "@t3tools/client-runtime/state/signalboxThreadStatus";
import type { ThreadStatusNotes } from "@t3tools/client-runtime/state/threadStatusLine";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import type { ThreadStatusNote } from "@t3tools/contracts/signalboxStatusLine";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentServerConfigsAtom } from "./server";

const signalboxThreadStatus = createSignalboxThreadStatusAtoms(connectionAtomRuntime);

/** An environment's notes: null when it doesn't keep them, or they haven't arrived yet. */
const environmentThreadStatusNotesAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ThreadStatusNotes | null => {
    const supported =
      get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
        .threadStatusNotes === true;
    if (!supported) return null;
    const result = get(signalboxThreadStatus.notes({ environmentId, input: {} }));
    return Option.getOrNull(AsyncResult.value(result));
  }).pipe(Atom.withLabel(`web-thread-status-notes:${environmentId}`)),
);

/**
 * One thread's note. The notes stream keeps an unchanged note's object, so a
 * row only redraws when its own note changes.
 */
const threadStatusNoteAtom = Atom.family((threadKey: string) =>
  Atom.make((get): ThreadStatusNote | null => {
    const ref = parseScopedThreadKey(threadKey);
    if (ref === null) return null;
    return get(environmentThreadStatusNotesAtom(ref.environmentId))?.get(ref.threadId) ?? null;
  }).pipe(Atom.withLabel(`web-thread-status-note:${threadKey}`)),
);

/** A thread's note: null until one was written, or where its environment keeps none. */
export function useThreadStatusNote(threadRef: ScopedThreadRef): ThreadStatusNote | null {
  return useAtomValue(threadStatusNoteAtom(scopedThreadKey(threadRef)));
}
