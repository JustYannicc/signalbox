/** signalbox: capability gates for an environment (see the web twin). */
import {
  type EnvironmentId,
  type ExecutionEnvironmentCapabilities,
  type SignalboxEnvironmentCapability,
  environmentSupports,
  showsEnvironmentUi,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { SIGNALBOX_APP_URL } from "@t3tools/shared/signalboxAppUrl";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useEnvironmentServerConfig, useServerConfigs } from "./entities";
import { environmentServerConfigsAtom } from "./server";
import { savedConnectionsByIdAtom } from "./use-remote-environment-registry";

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
 * environment can do `capability`. Before any has reported, `whileUnknown` decides.
 */
export function anyEnvironmentSupports(
  configs: Iterable<{
    readonly environment: { readonly capabilities: ExecutionEnvironmentCapabilities };
  }>,
  capability: SignalboxEnvironmentCapability,
  whileUnknown = true,
): boolean {
  let known = false;
  for (const config of configs) {
    if (environmentSupports(config.environment.capabilities, capability)) return true;
    known = true;
  }
  return known ? false : whileUnknown;
}

/**
 * Self-hosted shows a control until its environment says otherwise. Signalbox Cloud waits for
 * its config instead, so a control it doesn't serve never flashes while it connects.
 */
export function useAnyEnvironmentSupports(capability: SignalboxEnvironmentCapability): boolean {
  const configs = useServerConfigs();
  const showsEnvironments = useShowsEnvironmentUi();
  return useMemo(
    () => anyEnvironmentSupports(configs.values(), capability, showsEnvironments),
    [configs, capability, showsEnvironments],
  );
}

const SIGNALBOX_CLOUD_HOST = new URL(SIGNALBOX_APP_URL).host;

function isSignalboxCloudUrl(url: string): boolean {
  try {
    return new URL(url).host === SIGNALBOX_CLOUD_HOST;
  } catch {
    return false;
  }
}

/**
 * The capabilities `showsEnvironmentUi` judges each saved environment by. One that hasn't
 * reported yet (connecting, offline) counts as the one environment only when it is Signalbox
 * Cloud's URL, so an unreachable cloud still reads as Signalbox, not as an environment list.
 */
export function savedEnvironmentCapabilities(
  saved: Iterable<{ readonly environmentId: EnvironmentId; readonly httpBaseUrl: string }>,
  configs: ReadonlyMap<
    EnvironmentId,
    { readonly environment: { readonly capabilities: ExecutionEnvironmentCapabilities } }
  >,
): Array<{ readonly otherEnvironments?: boolean } | undefined> {
  return Array.from(
    saved,
    (connection) =>
      configs.get(connection.environmentId)?.environment.capabilities ??
      (isSignalboxCloudUrl(connection.httpBaseUrl) ? { otherEnvironments: false } : undefined),
  );
}

// A boolean, so catalog and config churn only re-renders consumers when the answer flips.
const showsEnvironmentUiAtom = Atom.make((get) =>
  showsEnvironmentUi(
    savedEnvironmentCapabilities(
      Object.values(get(savedConnectionsByIdAtom)),
      get(environmentServerConfigsAtom),
    ),
  ),
).pipe(Atom.withLabel("mobile:shows-environment-ui"));

/**
 * Whether to show environments at all: lists, pickers, filters, pairing, badges. See
 * `showsEnvironmentUi` in contracts; T3 Code, self-hosted and dev servers keep everything.
 */
export function useShowsEnvironmentUi(): boolean {
  return useAtomValue(showsEnvironmentUiAtom);
}
