/** signalbox: capability gates for an environment (see the web twin). */
import {
  type EnvironmentId,
  type SignalboxEnvironmentCapability,
  environmentSupports,
} from "@t3tools/contracts";

import { useEnvironmentServerConfig } from "./entities";

/** Supported until the environment says otherwise, including while its config loads. */
export function useEnvironmentSupports(
  environmentId: EnvironmentId | null | undefined,
  capability: SignalboxEnvironmentCapability,
): boolean {
  const config = useEnvironmentServerConfig(environmentId ?? null);
  return environmentSupports(config?.environment.capabilities, capability);
}
