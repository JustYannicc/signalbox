import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "./threads";
import {
  resolveUndoLastTurnTarget,
  sameUndoLastTurnTarget,
  type UndoLastTurnTarget,
} from "./undo-last-turn-target";

export type { UndoLastTurnTarget } from "./undo-last-turn-target";

// Every user row reads this, so it only changes identity when the target does,
// not on each streamed projection update.
const undoTargetAtomFamily = Atom.family((key: string) => {
  const { environmentId, threadId } = JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  };
  const ref = scopeThreadRef(environmentId, threadId);
  let previous: UndoLastTurnTarget | null = null;
  return Atom.make((get) => {
    const scoped = get(environmentThreadDetails.threadAtom(ref));
    const next = scoped === null ? null : resolveUndoLastTurnTarget(scoped.projection);
    if (sameUndoLastTurnTarget(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(`mobile-undo-last-turn:${key}`));
});

export function useUndoLastTurnTarget(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): UndoLastTurnTarget | null {
  return useAtomValue(undoTargetAtomFamily(JSON.stringify({ environmentId, threadId })));
}
