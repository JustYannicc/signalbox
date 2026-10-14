/** signalbox: capability gates for an environment (see the web twin). */
import {
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type SignalboxEnvironmentCapability,
  environmentSupports,
} from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentServerConfig, useServerConfigs } from "./entities";

/** Supported until the environment says otherwise, including while its config loads. */
export function useEnvironmentSupports(
  environmentId: EnvironmentId | null | undefined,
  capability: SignalboxEnvironmentCapability,
): boolean {
  const config = useEnvironmentServerConfig(environmentId ?? null);
  return environmentSupports(config?.environment.capabilities, capability);
}

/**
 * For controls that aren't tied to one environment: shown while any known
 * environment can do `capability`, or while none has reported yet.
 */
export function anyEnvironmentSupports(
  configs: Iterable<{
    readonly environment: { readonly capabilities: ExecutionEnvironmentCapabilities };
  }>,
  capability: SignalboxEnvironmentCapability,
): boolean {
  let known = false;
  for (const config of configs) {
    if (environmentSupports(config.environment.capabilities, capability)) return true;
    known = true;
  }
  return !known;
}

export function useAnyEnvironmentSupports(capability: SignalboxEnvironmentCapability): boolean {
  const configs = useServerConfigs();
  return useMemo(() => anyEnvironmentSupports(configs.values(), capability), [configs, capability]);
}
