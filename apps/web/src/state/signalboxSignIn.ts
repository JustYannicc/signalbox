/**
 * Standing sign-in grants (#575) on the environment that keeps them
 * (`capabilities.signInGrants`): Signalbox Cloud, the person's one environment.
 */
import { createSignalboxSignInAtoms } from "@t3tools/client-runtime/state/signalboxSignIn";
import type { EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useConnectedEnvironmentIds } from "./environments";

export const signalboxSignIn = createSignalboxSignInAtoms(connectionAtomRuntime);

/** The connected environment that keeps sign-in grants, or null when none does. */
export function useSignInGrantsEnvironmentId(): EnvironmentId | null {
  const configs = useServerConfigs();
  const connected = useConnectedEnvironmentIds();
  return connected.find((id) => configs.get(id)?.environment.capabilities.signInGrants) ?? null;
}
