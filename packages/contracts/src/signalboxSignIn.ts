/**
 * Standing sign-in grants (#575): "you're fine, sign agents in every time",
 * for every site or one site at a time, until revoked. Part of `WsRpcGroup`.
 *
 * A grant names the credentials it covers: the person's own 1Password (their
 * device link), or a folder's 1Password source. Credentials follow the folder
 * tree (#344), so a folder's grant decides for that folder's turns whoever is
 * talking, and a person's grant serves only turns they requested. Agents never
 * grant: a grant is the person deciding for their agents. Signalbox Cloud
 * holds them; a self-hosted server has none.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { NonNegativeInt } from "./baseSchemas.ts";
import { FolderId } from "./signalboxFolders.ts";

export const SIGNALBOX_SIGN_IN_WS_METHODS = {
  subscribe: "signalbox.signIn.subscribe",
  grant: "signalbox.signIn.grant",
  revoke: "signalbox.signIn.revoke",
  check: "signalbox.signIn.check",
} as const;

/** Granting and revoking change what agents may do as you, like a setting. */
export const SIGNALBOX_SIGN_IN_REQUIRED_SCOPES = {
  [SIGNALBOX_SIGN_IN_WS_METHODS.subscribe]: AuthOrchestrationReadScope,
  [SIGNALBOX_SIGN_IN_WS_METHODS.grant]: AuthSettingsWriteScope,
  [SIGNALBOX_SIGN_IN_WS_METHODS.revoke]: AuthSettingsWriteScope,
  [SIGNALBOX_SIGN_IN_WS_METHODS.check]: AuthOrchestrationReadScope,
} as const;

/** The site of a grant that covers every site. */
export const SIGN_IN_EVERYWHERE = "*";

/** Whose credentials a grant covers: your own 1Password, or a folder's source. */
export const SignInSource = Schema.Union([
  Schema.TaggedStruct("person", {}),
  Schema.TaggedStruct("folder", { folderId: FolderId }),
]);
export type SignInSource = typeof SignInSource.Type;

export const SignInGrant = Schema.Struct({
  id: Schema.String,
  source: SignInSource,
  /** `SIGN_IN_EVERYWHERE`, or a host: it covers that host and every host below it. */
  site: Schema.String,
  /** The person who granted it. */
  grantedBy: Schema.String,
  grantedAt: NonNegativeInt,
});
export type SignInGrant = typeof SignInGrant.Type;

/** Every grant in force, everywhere grants first, then by site. */
export const SignInGrants = Schema.Struct({ grants: Schema.Array(SignInGrant) });
export type SignInGrants = typeof SignInGrants.Type;

export const SignInGrantInput = Schema.Struct({
  source: SignInSource,
  /** `SIGN_IN_EVERYWHERE`, a host or a URL; the server keeps its host. */
  site: Schema.String.check(Schema.isMaxLength(2048)),
});
export type SignInGrantInput = typeof SignInGrantInput.Type;

/** Revoked grants stop the next sign-in; nothing is cached. */
export const SignInRevokeInput = Schema.Struct({ id: Schema.String });
export type SignInRevokeInput = typeof SignInRevokeInput.Type;

/** What the login service asks before a sign-in, for one of your own sources. */
export const SignInCheckInput = Schema.Struct({
  source: SignInSource,
  /** The page that needs a sign-in, or a site. */
  origin: Schema.String.check(Schema.isMaxLength(2048)),
});
export type SignInCheckInput = typeof SignInCheckInput.Type;

/**
 * The login service's answer for one sign-in:
 * - `allowed`: a grant covers it; the narrowest one is named.
 * - `ask`: none does, so the person is asked "Let agents sign in to `site`?",
 *   `site` being the address the site's accounts usually share.
 * - `not-owner`: the turn wasn't requested by the person whose 1Password this
 *   is. It never signs in; the person is asked instead.
 */
export const SignInAnswer = Schema.Union([
  Schema.TaggedStruct("allowed", { grant: SignInGrant }),
  Schema.TaggedStruct("ask", { site: Schema.String }),
  Schema.TaggedStruct("not-owner", {}),
]);
export type SignInAnswer = typeof SignInAnswer.Type;

/** A grant change or check was refused or failed; `message` says why, for the person. */
export class SignInGrantError extends Schema.TaggedError<SignInGrantError>()("SignInGrantError", {
  message: Schema.String,
}) {}

const error = Schema.Union([SignInGrantError, EnvironmentAuthorizationError]);

/** The grants now and after every change, from any device. */
const SubscribeRpc = Rpc.make(SIGNALBOX_SIGN_IN_WS_METHODS.subscribe, {
  payload: Schema.Struct({}),
  success: SignInGrants,
  error,
  stream: true,
});

const GrantRpc = Rpc.make(SIGNALBOX_SIGN_IN_WS_METHODS.grant, {
  payload: SignInGrantInput,
  success: SignInGrants,
  error,
});

const RevokeRpc = Rpc.make(SIGNALBOX_SIGN_IN_WS_METHODS.revoke, {
  payload: SignInRevokeInput,
  success: SignInGrants,
  error,
});

/** The same answer the login service gets, for a turn you requested. */
const CheckRpc = Rpc.make(SIGNALBOX_SIGN_IN_WS_METHODS.check, {
  payload: SignInCheckInput,
  success: SignInAnswer,
  error,
});

/** Spread into `WsRpcGroup`, which applies its scope authorization to them. */
export const SIGNALBOX_SIGN_IN_RPCS = [SubscribeRpc, GrantRpc, RevokeRpc, CheckRpc] as const;
