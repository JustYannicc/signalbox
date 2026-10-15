/**
 * Personal keys: a person's revocable credentials for their own computers and
 * scripts. Part of `WsRpcGroup`. A key can run local harnesses on the person's
 * pool (`model`), call the public API within its `scopes`, or both. Signalbox
 * Cloud holds them; a self-hosted server has none.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthEnvironmentScopes,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";

export const SIGNALBOX_KEYS_WS_METHODS = {
  list: "signalbox.keys.list",
  create: "signalbox.keys.create",
  revoke: "signalbox.keys.revoke",
} as const;

/** Making and revoking a credential changes what can act as you, like a setting. */
export const SIGNALBOX_KEYS_REQUIRED_SCOPES = {
  [SIGNALBOX_KEYS_WS_METHODS.list]: AuthOrchestrationReadScope,
  [SIGNALBOX_KEYS_WS_METHODS.create]: AuthSettingsWriteScope,
  [SIGNALBOX_KEYS_WS_METHODS.revoke]: AuthSettingsWriteScope,
} as const;

export const PersonalKey = Schema.Struct({
  /** Public: safe to show and to revoke by. */
  id: Schema.String,
  label: Schema.String,
  scopes: AuthEnvironmentScopes,
  model: Schema.Boolean,
  createdAt: Schema.Number,
  lastUsedAt: Schema.NullOr(Schema.Number),
});
export type PersonalKey = typeof PersonalKey.Type;

export const PersonalKeyList = Schema.Struct({ keys: Schema.Array(PersonalKey) });
export type PersonalKeyList = typeof PersonalKeyList.Type;

export const PersonalKeyCreateInput = Schema.Struct({
  /** Where it's used: a computer's name, a script's purpose. */
  label: Schema.String.check(Schema.isMaxLength(200)),
  /** What it may call in the public API; never more than the caller holds. */
  scopes: AuthEnvironmentScopes,
  /** Whether local harnesses may run on the pool with it. */
  model: Schema.Boolean,
});
export type PersonalKeyCreateInput = typeof PersonalKeyCreateInput.Type;

/** The key itself, shown once: it's never stored. */
export const PersonalKeyCreated = Schema.Struct({ key: Schema.String });
export type PersonalKeyCreated = typeof PersonalKeyCreated.Type;

export class PersonalKeyError extends Schema.TaggedError<PersonalKeyError>()("PersonalKeyError", {
  message: Schema.String,
}) {}

const error = Schema.Union([PersonalKeyError, EnvironmentAuthorizationError]);

const ListRpc = Rpc.make(SIGNALBOX_KEYS_WS_METHODS.list, {
  payload: Schema.Struct({}),
  success: PersonalKeyList,
  error,
});

const CreateRpc = Rpc.make(SIGNALBOX_KEYS_WS_METHODS.create, {
  payload: PersonalKeyCreateInput,
  success: PersonalKeyCreated,
  error,
});

/** Its next request is refused; nothing is cached. */
const RevokeRpc = Rpc.make(SIGNALBOX_KEYS_WS_METHODS.revoke, {
  payload: Schema.Struct({ id: Schema.String }),
  success: PersonalKeyList,
  error,
});

export const SIGNALBOX_KEYS_RPCS = [ListRpc, CreateRpc, RevokeRpc] as const;
