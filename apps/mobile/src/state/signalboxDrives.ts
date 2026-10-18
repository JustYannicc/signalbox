/** Signalbox Cloud drives, per cloud environment. */
import { createSignalboxDrivesAtoms } from "@t3tools/client-runtime/state/signalboxDrives";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { useEnvironmentQuery } from "./query";

export const signalboxDrives = createSignalboxDrivesAtoms(connectionAtomRuntime);

/** Every drive the user can open in a cloud environment; null elsewhere or until it arrives. */
export function useEnvironmentDrives(environmentId: EnvironmentId | null) {
  const cloud =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.signalboxCloud === true;
  return useEnvironmentQuery(
    cloud && environmentId !== null ? signalboxDrives.snapshot({ environmentId, input: {} }) : null,
  ).data;
}
