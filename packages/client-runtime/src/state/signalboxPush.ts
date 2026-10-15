import { SIGNALBOX_PUSH_WS_METHODS } from "@t3tools/contracts/signalboxPush";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * Registering a phone for Signalbox Cloud's pushes. Only ask environments
 * advertising `capabilities.signalboxCloud`; others fail with
 * `SignalboxPushUnavailableError`.
 */
export function createSignalboxPushAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Input: the relay's device registration. Without a push token it forgets the phone. */
    registerDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:signalbox-push:register-device",
      tag: SIGNALBOX_PUSH_WS_METHODS.registerDevice,
    }),
    /** Input `{ deviceId }`. */
    unregisterDevice: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:signalbox-push:unregister-device",
      tag: SIGNALBOX_PUSH_WS_METHODS.unregisterDevice,
    }),
  };
}
