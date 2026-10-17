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
import { isHostedStaticApp } from "../hostedPairing";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { environmentServerConfigsAtom, primaryServerConfigAtom, serverEnvironment } from "./server";

/** Supported until the environment says otherwise, unless the caller waits for config. */
export function useEnvironmentSupports(
  environmentId: EnvironmentId | null | undefined,
  capability: SignalboxEnvironmentCapability,
  options: { readonly waitForConfig?: boolean } = {},
): boolean {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId ?? null));
  if (options.waitForConfig && config === null) return false;
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
 * `showsEnvironmentUi` in contracts). T3 Code and self-hosted servers never say, so they keep
 * it all. Until an environment has reported, the answer is unknown and environment UI stays
 * hidden: the cloud's config can take seconds to arrive, and flashing pairing UI at people who
 * have one environment is worse than a self-hosted page filling in a moment later. A desktop
 * gateway without a local environment only ever reaches the cloud, so it knows right away.
 */
export type EnvironmentUiState = "unknown" | "shown" | "hidden";

export function resolveEnvironmentUiState(input: {
  /** A desktop gateway: it only ever reaches Signalbox Cloud. */
  readonly gateway: boolean;
  /** This client is served by an environment whose config may still be loading. */
  readonly hasPrimary: boolean;
  readonly reported: ReadonlyArray<{ readonly [K in SignalboxEnvironmentCapability]?: boolean }>;
}): EnvironmentUiState {
  if (input.gateway) return "hidden";
  // A client with no environment of its own (upstream's hosted app) needs the way in.
  if (input.reported.length === 0) return input.hasPrimary ? "unknown" : "shown";
  return showsEnvironmentUi(input.reported) ? "shown" : "hidden";
}

// Known before the primary registers (that waits on an HTTP fetch), so a cold load never
// starts out "shown". Fixed for the renderer's life; the desktop check is a sync IPC.
let cachedServedByAnEnvironment: boolean | undefined;
function servedByAnEnvironment(): boolean {
  cachedServedByAnEnvironment ??=
    typeof window !== "undefined" &&
    !isLocalEnvironmentDisabled() &&
    !isHostedStaticApp(new URL(window.location.href));
  return cachedServedByAnEnvironment;
}

const environmentUiStateAtom = Atom.make((get): EnvironmentUiState => {
  const primary = get(primaryServerConfigAtom);
  const configs = [...(primary ? [primary] : []), ...get(environmentServerConfigsAtom).values()];
  return resolveEnvironmentUiState({
    gateway: cloudDefaultOrigin() !== null,
    hasPrimary: servedByAnEnvironment(),
    reported: configs.map((config) => config.environment.capabilities),
  });
}).pipe(Atom.withLabel("web-environment-ui-state"));

/** For routes that redirect away: wait while `unknown` rather than bounce a self-hosted link. */
export function useEnvironmentUiState(): EnvironmentUiState {
  return useAtomValue(environmentUiStateAtom);
}

/** `useShowsEnvironmentUi` outside React, for toasts and thrown errors. */
export function readShowsEnvironmentUi(): boolean {
  return appAtomRegistry.get(environmentUiStateAtom) === "shown";
}

export function useShowsEnvironmentUi(): boolean {
  return useEnvironmentUiState() === "shown";
}
