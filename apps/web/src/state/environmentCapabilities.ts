/**
 * signalbox: whether an environment can do something a self-hosted server can
 * (`signalboxCapabilities.ts` in contracts). Gate a control on these instead of
 * checking for Signalbox Cloud.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type SignalboxEnvironmentCapability,
  environmentSupports,
} from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";

/** Supported until the environment says otherwise, including while its config loads. */
export function useEnvironmentSupports(
  environmentId: EnvironmentId | null | undefined,
  capability: SignalboxEnvironmentCapability,
): boolean {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId ?? null));
  return environmentSupports(config?.environment.capabilities, capability);
}

export function readEnvironmentSupports(
  environmentId: EnvironmentId | null | undefined,
  capability: SignalboxEnvironmentCapability,
): boolean {
  if (environmentId == null) return true;
  return environmentSupports(
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities,
    capability,
  );
}
