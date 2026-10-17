import { createSignalboxTrashAtoms } from "@t3tools/client-runtime/state/signalboxTrash";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments } from "./environments";

export const signalboxTrash = createSignalboxTrashAtoms(connectionAtomRuntime);

/** Keep every cloud's Trash visible, including an offline cloud's reconnect state. */
export function useTrashEnvironments() {
  return useEnvironments().environments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.folders === true,
  );
}
