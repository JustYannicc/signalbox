/**
 * Signalbox push devices. Part of `WsRpcGroup`.
 *
 * A phone registers its APNs or FCM token with Signalbox Cloud, which then
 * pushes the person's needs-yous, failures and finished long turns straight to
 * it, whether or not any client is open. The registration is the one the app
 * already sends the Signalbox Connect relay, so one payload serves both.
 *
 * A self-hosted server answers `SignalboxPushUnavailableError`: its pushes go
 * through the relay instead.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { RelayDeviceRegistrationRequest } from "./relay.ts";

export const SIGNALBOX_PUSH_WS_METHODS = {
  registerDevice: "signalbox.push.registerDevice",
  unregisterDevice: "signalbox.push.unregisterDevice",
} as const;

/** Being told about threads is reading them. */
export const SIGNALBOX_PUSH_REQUIRED_SCOPES = {
  [SIGNALBOX_PUSH_WS_METHODS.registerDevice]: AuthOrchestrationReadScope,
  [SIGNALBOX_PUSH_WS_METHODS.unregisterDevice]: AuthOrchestrationReadScope,
} as const;

/** The phone and where to reach it; the same request the relay takes. */
export const SignalboxPushDeviceRegistration = RelayDeviceRegistrationRequest;
export type SignalboxPushDeviceRegistration = typeof SignalboxPushDeviceRegistration.Type;

export const SignalboxPushDeviceRemoval = Schema.Struct({ deviceId: TrimmedNonEmptyString });
export type SignalboxPushDeviceRemoval = typeof SignalboxPushDeviceRemoval.Type;

export class SignalboxPushUnavailableError extends Schema.TaggedError<SignalboxPushUnavailableError>()(
  "SignalboxPushUnavailableError",
  {},
) {
  override get message(): string {
    return "This server sends pushes through the relay, not Signalbox Cloud.";
  }
}

/** The device couldn't be saved or removed right now. */
export class SignalboxPushError extends Schema.TaggedError<SignalboxPushError>()(
  "SignalboxPushError",
  { message: Schema.String },
) {}

const PushErrors = Schema.Union([
  SignalboxPushUnavailableError,
  SignalboxPushError,
  EnvironmentAuthorizationError,
]);

/** Saves or updates this phone. Idempotent per `deviceId`. */
const RegisterDeviceRpc = Rpc.make(SIGNALBOX_PUSH_WS_METHODS.registerDevice, {
  payload: SignalboxPushDeviceRegistration,
  error: PushErrors,
});

/** Forgets this phone, e.g. on sign-out. Removing an unknown device succeeds. */
const UnregisterDeviceRpc = Rpc.make(SIGNALBOX_PUSH_WS_METHODS.unregisterDevice, {
  payload: SignalboxPushDeviceRemoval,
  error: PushErrors,
});

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_PUSH_RPCS = [RegisterDeviceRpc, UnregisterDeviceRpc] as const;
