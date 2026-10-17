import { SIGNALBOX_NOTES_WS_METHODS } from "@t3tools/contracts/signalboxNotes";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export * from "./notesModel.ts";

/**
 * A Signalbox Cloud user's notes, for one environment. Only environments
 * advertising `capabilities.notes` serve them.
 */
export function createSignalboxNotesAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:signalbox-notes:snapshot",
      tag: SIGNALBOX_NOTES_WS_METHODS.subscribe,
    }),
    createNote: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-notes:create",
      tag: SIGNALBOX_NOTES_WS_METHODS.create,
    }),
    updateNote: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-notes:update",
      tag: SIGNALBOX_NOTES_WS_METHODS.update,
    }),
    deleteNote: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-notes:delete",
      tag: SIGNALBOX_NOTES_WS_METHODS.delete,
    }),
    readAgain: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-notes:read-again",
      tag: SIGNALBOX_NOTES_WS_METHODS.readAgain,
    }),
    dismissReading: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-notes:dismiss-reading",
      tag: SIGNALBOX_NOTES_WS_METHODS.dismissReading,
    }),
    acceptNote: createEnvironmentRpcCommand(runtime, {
      label: "signalbox-notes:accept",
      tag: SIGNALBOX_NOTES_WS_METHODS.accept,
    }),
  };
}
