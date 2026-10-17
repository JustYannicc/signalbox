import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { createSignalboxPushAtoms } from "@t3tools/client-runtime/state/signalboxPush";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { savedConnectionsByIdAtom } from "../../state/use-remote-environment-registry";
import type { SavedRemoteConnection } from "../../lib/connection";

/**
 * signalbox: Signalbox Cloud pushes straight to this phone, with no relay
 * account in between. The phone hands every cloud it's connected to the same
 * registration it sends the relay; a cloud keeps it for the session the phone
 * signed in with. Registering again is cheap and idempotent, so there's no
 * local cache that could miss a new session after signing in again.
 */

const commands = createSignalboxPushAtoms(connectionAtomRuntime);

export type SignalboxCloudPushStatus = "unknown" | "pending" | "registered" | "disabled" | "failed";
let status: SignalboxCloudPushStatus = "unknown";
let registeredIdentity = "";
let generation = 0;
const listeners = new Set<() => void>();

/** A new cloud session must register again, even when its environment id is unchanged. */
export function signalboxCloudPushIdentity(
  configs: ReadonlyMap<EnvironmentId, ServerConfig>,
  connections: Readonly<Record<EnvironmentId, SavedRemoteConnection>>,
): string {
  return JSON.stringify(
    signalboxCloudIds(configs).map((id) => {
      const connection = connections[id];
      return [id, connection?.httpBaseUrl, connection?.bearerToken, connection?.dpopAccessToken];
    }),
  );
}

const currentIdentity = () =>
  signalboxCloudPushIdentity(
    appAtomRegistry.get(environmentServerConfigsAtom),
    appAtomRegistry.get(savedConnectionsByIdAtom),
  );

function setStatus(next: SignalboxCloudPushStatus): void {
  status = next;
  for (const listener of listeners) listener();
}

export function getSignalboxCloudPushStatus(): SignalboxCloudPushStatus {
  return registeredIdentity === currentIdentity() ? status : "unknown";
}

export function subscribeSignalboxCloudPushStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetSignalboxCloudPushStatus(identity = currentIdentity()): void {
  generation++;
  registeredIdentity = identity;
  setStatus("unknown");
}

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
  const ids = signalboxCloudIds(appAtomRegistry.get(environmentServerConfigsAtom));
  if (ids.length === 0) return;
  const attempt = ++generation;
  const identity = currentIdentity();
  registeredIdentity = identity;
  setStatus("pending");
  const results = await Promise.all(
    // A cloud that couldn't be reached hears it on the next foreground.
    ids.map((environmentId) =>
      runAtomCommand(
        appAtomRegistry,
        commands.registerDevice,
        { environmentId, input: request },
        { reportFailure: false },
      ),
    ),
  );
  if (attempt !== generation || identity !== currentIdentity()) return;
  setStatus(
    results.every((result) => result._tag === "Success")
      ? request.pushToken && request.preferences.notificationsEnabled
        ? "registered"
        : "disabled"
      : "failed",
  );
}
