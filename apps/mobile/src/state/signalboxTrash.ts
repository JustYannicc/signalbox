import { createSignalboxTrashAtoms } from "@t3tools/client-runtime/state/signalboxTrash";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";

export const signalboxTrash = createSignalboxTrashAtoms(connectionAtomRuntime);

/** Each connected cloud owns a separate Trash. */
export function useTrashEnvironments() {
  return useEnvironments().environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.folders === true,
  );
}
