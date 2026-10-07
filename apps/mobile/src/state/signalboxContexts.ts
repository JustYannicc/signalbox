/** Signalbox Cloud contexts, per cloud environment (see the web twin). */
import { createSignalboxContextsAtoms } from "@t3tools/client-runtime/state/signalboxContexts";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentServerConfig } from "./entities";
import { useEnvironmentQuery } from "./query";

export const signalboxContexts = createSignalboxContextsAtoms(connectionAtomRuntime);

/** The environment's contexts, or null when it isn't Signalbox Cloud or hasn't sent them yet. */
export function useEnvironmentContexts(environmentId: EnvironmentId) {
  const isCloud =
    useEnvironmentServerConfig(environmentId)?.environment.capabilities.signalboxCloud === true;
  return useEnvironmentQuery(
    isCloud ? signalboxContexts.snapshot({ environmentId, input: {} }) : null,
  ).data;
}
