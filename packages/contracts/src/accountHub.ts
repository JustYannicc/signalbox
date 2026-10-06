/**
 * The account hub is the CLIProxyAPI instance Signalbox routes pooled
 * accounts through: one Signalbox runs itself, or one the user already runs.
 * It reports limits as an ordinary usage limit source with this fixed id, so
 * clients can tell it apart from a hub the user only added for limits.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

export const ACCOUNT_HUB_SOURCE_ID = UsageLimitSourceId.make("signalbox-account-hub");

const POOL_SOURCE_PREFIX = "signalbox-pool-";

/** Whether a usage limit source is one of Signalbox's account pools. */
export const isAccountPoolSourceId = (sourceId: string) =>
  sourceId === ACCOUNT_HUB_SOURCE_ID || sourceId.startsWith(POOL_SOURCE_PREFIX);

/** The sign-in method on a hub instance that signs one dead account in again. */
export const HUB_REAUTH_METHOD_PREFIX = "reauth:";
export const hubReauthMethodId = (accountId: string) => `${HUB_REAUTH_METHOD_PREFIX}${accountId}`;

const HubUrl = TrimmedNonEmptyString.check(Schema.isMaxLength(2048));
const HubKey = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));

/** Which hub pooled accounts go through. Keys never leave the server. */
export const AccountHubConnection = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("managed") }),
  Schema.Struct({ mode: Schema.Literal("external"), url: HubUrl }),
]);
export type AccountHubConnection = typeof AccountHubConnection.Type;

export const AccountHubSetConnectionInput = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("managed") }),
  Schema.Struct({
    mode: Schema.Literal("external"),
    url: HubUrl,
    /** CLIProxyAPI's `management.secret-key`. */
    managementKey: HubKey,
    /** One of its `access.api-keys`, which the harnesses send. */
    clientKey: HubKey,
  }),
]);
export type AccountHubSetConnectionInput = typeof AccountHubSetConnectionInput.Type;

export const AccountHubImportInput = Schema.Struct({
  url: HubUrl,
  managementKey: HubKey,
  /**
   * Remove each account from the source once it is copied. Accounts refresh
   * rotating tokens, so two hubs holding the same account sign each other out.
   */
  removeFromSource: Schema.Boolean,
});
export type AccountHubImportInput = typeof AccountHubImportInput.Type;

export const AccountHubImportResult = Schema.Struct({
  imported: Schema.Array(Schema.String),
  /** Already in the hub under the same name. */
  skipped: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
});
export type AccountHubImportResult = typeof AccountHubImportResult.Type;

export class AccountHubRpcError extends Schema.TaggedError<AccountHubRpcError>()(
  "AccountHubRpcError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

/**
 * Pools: named sets of accounts that work spreads across. Each pool has its
 * own hub. Backing (Signalbox's own CLIProxyAPI or one the user runs) is a
 * detail of the pool; the name is whatever the user calls it.
 */
export const PERSONAL_POOL_ID = "personal";

export const AccountPoolId = TrimmedNonEmptyString.check(Schema.isPattern(/^[a-z0-9-]{1,40}$/u));
export type AccountPoolId = typeof AccountPoolId.Type;

const PoolName = TrimmedNonEmptyString.check(Schema.isMaxLength(60));

export const AccountPool = Schema.Struct({
  id: AccountPoolId,
  name: PoolName,
  /** The usage limit source its accounts report under. */
  sourceId: UsageLimitSourceId,
  backing: AccountHubConnection,
  /** The pool every install starts with; it can be renamed but not deleted. */
  personal: Schema.Boolean,
});
export type AccountPool = typeof AccountPool.Type;

export const AccountPoolCreateInput = Schema.Struct({ name: PoolName });
export type AccountPoolCreateInput = typeof AccountPoolCreateInput.Type;

export const AccountPoolRenameInput = Schema.Struct({ poolId: AccountPoolId, name: PoolName });
export type AccountPoolRenameInput = typeof AccountPoolRenameInput.Type;

export const AccountPoolDeleteInput = Schema.Struct({ poolId: AccountPoolId });
export type AccountPoolDeleteInput = typeof AccountPoolDeleteInput.Type;

export const AccountPoolSetBackingInput = Schema.Struct({
  poolId: AccountPoolId,
  backing: AccountHubSetConnectionInput,
});
export type AccountPoolSetBackingInput = typeof AccountPoolSetBackingInput.Type;

export const AccountPoolImportInput = Schema.Struct({
  poolId: AccountPoolId,
  ...AccountHubImportInput.fields,
});
export type AccountPoolImportInput = typeof AccountPoolImportInput.Type;

/** The usage limit source a pool's accounts report under. */
export const poolSourceId = (poolId: string) =>
  UsageLimitSourceId.make(
    poolId === PERSONAL_POOL_ID ? ACCOUNT_HUB_SOURCE_ID : `${POOL_SOURCE_PREFIX}${poolId}`,
  );

/** The pool behind a usage limit source, or null when it is not a pool. */
export const poolIdForSourceId = (sourceId: string) =>
  sourceId === ACCOUNT_HUB_SOURCE_ID
    ? PERSONAL_POOL_ID
    : sourceId.startsWith(POOL_SOURCE_PREFIX)
      ? sourceId.slice(POOL_SOURCE_PREFIX.length)
      : null;

/** The pool a provider instance runs on, or null when it is not a pool instance. */
export const hubInstancePoolId = (config: unknown): string | null => {
  if (config === null || typeof config !== "object" || !("setupMode" in config)) return null;
  if (config.setupMode !== "hub") return null;
  return "poolId" in config && typeof config.poolId === "string" && config.poolId
    ? config.poolId
    : PERSONAL_POOL_ID;
};

/** The provider instance id of a pool's instance for one kind (`codex`, `claude`, `grok`, `antigravity`). */
export const poolInstanceId = (kind: string, poolId: string) =>
  poolId === PERSONAL_POOL_ID ? `${kind}_hub` : `${kind}_hub_${poolId}`;
