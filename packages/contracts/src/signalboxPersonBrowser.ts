/**
 * The person's one Signalbox Cloud browser profile. Its name and Kernel
 * details stay on the cloud; people can see whether it is available and
 * clear its saved site data.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationReadScope,
  AuthPreviewOperateScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";

export const SIGNALBOX_PERSON_BROWSER_WS_METHODS = {
  profileStatus: "signalbox.personBrowser.profileStatus",
  clearProfile: "signalbox.personBrowser.clearProfile",
} as const;

export const SIGNALBOX_PERSON_BROWSER_REQUIRED_SCOPES = {
  [SIGNALBOX_PERSON_BROWSER_WS_METHODS.profileStatus]: AuthOrchestrationReadScope,
  [SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile]: AuthPreviewOperateScope,
} as const;

/** Whether this cloud can provide the account's single managed browser profile. */
export const SignalboxPersonBrowserProfileStatus = Schema.Struct({
  available: Schema.Boolean,
});
export type SignalboxPersonBrowserProfileStatus = typeof SignalboxPersonBrowserProfileStatus.Type;

export class SignalboxPersonBrowserError extends Schema.TaggedError<SignalboxPersonBrowserError>()(
  "SignalboxPersonBrowserError",
  { message: Schema.String },
) {}

const errors = Schema.Union([SignalboxPersonBrowserError, EnvironmentAuthorizationError]);

const ProfileStatusRpc = Rpc.make(SIGNALBOX_PERSON_BROWSER_WS_METHODS.profileStatus, {
  payload: Schema.Struct({}),
  success: SignalboxPersonBrowserProfileStatus,
  error: errors,
});

const ClearProfileRpc = Rpc.make(SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile, {
  payload: Schema.Struct({}),
  error: errors,
});

export const SIGNALBOX_PERSON_BROWSER_RPCS = [ProfileStatusRpc, ClearProfileRpc] as const;
