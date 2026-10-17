/** Signalbox Cloud notes, per cloud environment (`@t3tools/contracts/signalboxNotes`). */
import { createSignalboxNotesAtoms } from "@t3tools/client-runtime/state/signalboxNotes";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { useEnvironmentQuery } from "./query";

export const signalboxNotes = createSignalboxNotesAtoms(connectionAtomRuntime);

/** Whether the environment keeps notes. Only Signalbox Cloud does. */
export function useEnvironmentHasNotes(environmentId: EnvironmentId | null): boolean {
  return useEnvironmentServerConfig(environmentId)?.environment.capabilities.notes === true;
}

/** Every note the user can see there; data is null where it has none or hasn't sent them yet. */
export function useEnvironmentNotes(environmentId: EnvironmentId | null) {
  const supported = useEnvironmentHasNotes(environmentId);
  return useEnvironmentQuery(
    supported && environmentId !== null
      ? signalboxNotes.snapshot({ environmentId, input: {} })
      : null,
  );
}
