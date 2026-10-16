/** signalbox: standing sign-in grants (#575), on the environment that keeps them. */
import { createSignalboxSignInAtoms } from "@t3tools/client-runtime/state/signalboxSignIn";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";

export const signalboxSignIn = createSignalboxSignInAtoms(connectionAtomRuntime);

/** The environment that keeps sign-in grants (`capabilities.signInGrants`), or null. */
export function useSignInGrantsEnvironmentId(): EnvironmentId | null {
  const configs = useServerConfigs();
  for (const [environmentId, config] of configs) {
    if (config.environment.capabilities.signInGrants === true) return environmentId;
  }
  return null;
}
