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
  showsEnvironmentUi,
} from "@t3tools/contracts";

import { Atom } from "effect/reactivity";

import { cloudDefaultOrigin } from "../account/cloudDefault";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom, primaryServerConfigAtom, serverEnvironment } from "./server";

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

/**
 * Whether to show environments at all: pickers, lists, Add environment, pairing, the local
 * environment and its network access. Signalbox Cloud is the user's one environment and says
 * `otherEnvironments: false`, so web and desktop then never mention environments (see
 * `showsEnvironmentUi` in contracts). A desktop
 * gateway without a local environment only ever reaches the cloud, so it hides them before
 * signing in too. T3 Code and self-hosted servers never say, so they keep it all.
 */
export const showsEnvironmentUiAtom = Atom.make((get) => {
  if (cloudDefaultOrigin() !== null) return false;
  const primary = get(primaryServerConfigAtom);
  const configs = [...(primary ? [primary] : []), ...get(environmentServerConfigsAtom).values()];
  return showsEnvironmentUi(configs.map((config) => config.environment.capabilities));
}).pipe(Atom.withLabel("web-shows-environment-ui"));

export function useShowsEnvironmentUi(): boolean {
  return useAtomValue(showsEnvironmentUiAtom);
}
