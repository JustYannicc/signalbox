import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { createSignalboxPushAtoms } from "@t3tools/client-runtime/state/signalboxPush";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";

/**
 * signalbox: Signalbox Cloud pushes straight to this phone, with no relay
 * account in between. The phone hands every cloud it's connected to the same
 * registration it sends the relay; a cloud keeps it for the session the phone
 * signed in with. Registering again is cheap and idempotent, so there's no
 * local cache that could miss a new session after signing in again.
 */

const commands = createSignalboxPushAtoms(connectionAtomRuntime);

/** The connected environments that are Signalbox Cloud, in a stable order. */
export function signalboxCloudIds(
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
): ReadonlyArray<EnvironmentId> {
  return [...configs]
    .filter(([, config]) => config.environment.capabilities.signalboxCloud === true)
    .map(([environmentId]) => environmentId)
    .sort();
}

/** Registers the phone with every connected cloud. */
export async function registerWithSignalboxClouds(
  request: RelayDeviceRegistrationRequest,
): Promise<void> {
  await Promise.all(
    // A cloud that couldn't be reached hears it on the next foreground.
    signalboxCloudIds(appAtomRegistry.get(environmentServerConfigsAtom)).map((environmentId) =>
      runAtomCommand(
        appAtomRegistry,
        commands.registerDevice,
        { environmentId, input: request },
        { reportFailure: false },
      ),
    ),
  );
}
