/**
 * Signalbox contexts. Part of `WsRpcGroup`.
 *
 * A context is an account a user works as: Personal, plus every work
 * organization they belong to, all shown at once. A thread acts as exactly one
 * context, the one its project belongs to. Sections organize each context
 * (`sections.ts`, whose sections carry a `contextId` in Signalbox Cloud). See
 * #125.
 *
 * Only Signalbox Cloud serves these (`capabilities.signalboxCloud`). A
 * self-hosted server answers `SignalboxContextsUnavailableError`.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { AuthOrchestrationReadScope, EnvironmentAuthorizationError } from "./auth.ts";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SIGNALBOX_CONTEXTS_WS_METHODS = {
  subscribe: "signalbox.contexts.subscribe",
} as const;

/** Reading contexts is part of reading the sidebar. */
export const SIGNALBOX_CONTEXTS_REQUIRED_SCOPES = {
  [SIGNALBOX_CONTEXTS_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
} as const;

/** `"personal"`, or the WorkOS organization id of a work context. */
export const SignalboxContextId = TrimmedNonEmptyString.pipe(Schema.brand("SignalboxContextId"));
export type SignalboxContextId = typeof SignalboxContextId.Type;

/** Every user has exactly one Personal context. */
export const PERSONAL_CONTEXT_ID = SignalboxContextId.make("personal");

export const SignalboxContext = Schema.Struct({
  id: SignalboxContextId,
  kind: Schema.Literals(["personal", "organization"]),
  name: Schema.String,
  /** The context's projects in the shell. A thread started in one acts as this context. */
  projectIds: Schema.Array(ProjectId),
});
export type SignalboxContext = typeof SignalboxContext.Type;

/** The user's contexts, Personal first. */
export const SignalboxContextsSnapshot = Schema.Struct({
  contexts: Schema.Array(SignalboxContext),
});
export type SignalboxContextsSnapshot = typeof SignalboxContextsSnapshot.Type;

export class SignalboxContextsUnavailableError extends Schema.TaggedError<SignalboxContextsUnavailableError>()(
  "SignalboxContextsUnavailableError",
  {},
) {
  override get message(): string {
    return "Contexts are only available in Signalbox Cloud.";
  }
}

/** A snapshot now and after every change to the user's contexts. */
const SubscribeRpc = Rpc.make(SIGNALBOX_CONTEXTS_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: SignalboxContextsSnapshot,
  error: Schema.Union([SignalboxContextsUnavailableError, EnvironmentAuthorizationError]),
  stream: true,
});

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_CONTEXTS_RPCS = [SubscribeRpc] as const;
