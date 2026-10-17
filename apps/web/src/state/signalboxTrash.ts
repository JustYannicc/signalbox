/**
 * Trash (#474) on the environment that keeps it: Signalbox Cloud, the
 * environment that keeps folders (`capabilities.folders`).
 */
import { createSignalboxTrashAtoms } from "@t3tools/client-runtime/state/signalboxTrash";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useConnectedEnvironmentIds } from "./environments";

export const signalboxTrash = createSignalboxTrashAtoms(connectionAtomRuntime);

/** The connected environment that keeps a Trash, or null when none does. */
export function useTrashEnvironmentId(): EnvironmentId | null {
  const configs = useServerConfigs();
  const connected = useConnectedEnvironmentIds();
  return connected.find((id) => configs.get(id)?.environment.capabilities.folders) ?? null;
}
