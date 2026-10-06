/** Signalbox Cloud contexts and sections, per cloud environment (see the web twin). */
import { createSignalboxContextsAtoms } from "@t3tools/client-runtime/state/signalboxContexts";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";

export const signalboxContexts = createSignalboxContextsAtoms(connectionAtomRuntime);

/** Connected environments that are Signalbox Cloud, the only ones with contexts. */
export function useCloudEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const configs = useServerConfigs();
  return useMemo(
    () =>
      [...configs]
        .filter(([, config]) => config.environment.capabilities.signalboxCloud === true)
        .map(([environmentId]) => environmentId),
    [configs],
  );
}

export function useContextsSnapshot(environmentId: EnvironmentId) {
  return useEnvironmentQuery(signalboxContexts.snapshot({ environmentId, input: {} })).data;
}
