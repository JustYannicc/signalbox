/** signalbox: Trash (#474), on the environment that keeps folders. */
import { createSignalboxTrashAtoms } from "@t3tools/client-runtime/state/signalboxTrash";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";

export const signalboxTrash = createSignalboxTrashAtoms(connectionAtomRuntime);

/** The environment that keeps a Trash (Signalbox Cloud, `capabilities.folders`), or null. */
export function useTrashEnvironmentId(): EnvironmentId | null {
  const configs = useServerConfigs();
  for (const [environmentId, config] of configs) {
    if (config.environment.capabilities.folders === true) return environmentId;
  }
  return null;
}
