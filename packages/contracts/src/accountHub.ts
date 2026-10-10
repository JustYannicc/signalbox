/**
 * The account hub is the CLIProxyAPI instance Signalbox routes pooled
 * accounts through: one Signalbox runs itself, or one the user already runs.
 * It reports limits as an ordinary usage limit source with this fixed id, so
 * clients can tell it apart from a hub the user only added for limits.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "./providerInstance.ts";
import { ServerProviderUsageWindow } from "./providerUsageLimits.ts";
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

/**
 * A pool as anyone allowed to use it sees it: what is left per provider and
 * window and when it next resets. No account count, emails, plans, or banked
 * resets, so it is safe to hand to a pool's members and to agents.
 */
export const AccountPoolUsageWindow = Schema.Struct({
  label: Schema.String,
  kind: ServerProviderUsageWindow.fields.kind,
  /** Share of the pool's quota still open in this window, 0..100. */
  remainingPercent: Schema.Number,
  /** The soonest reset that hands quota back to the pool. */
  nextResetAt: Schema.optional(IsoDateTime),
});
export type AccountPoolUsageWindow = typeof AccountPoolUsageWindow.Type;

export const AccountPoolProvider = Schema.Struct({
  /** Pass this as the provider instance to run a thread or task on this pool. */
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.String,
  /** Whether the pool has an account that can take turns for this provider now. */
  available: Schema.Boolean,
  usage: Schema.Array(AccountPoolUsageWindow),
});
export type AccountPoolProvider = typeof AccountPoolProvider.Type;

export const AccountPoolOverview = Schema.Struct({
  id: AccountPoolId,
  name: PoolName,
  providers: Schema.Array(AccountPoolProvider),
});
export type AccountPoolOverview = typeof AccountPoolOverview.Type;

/**
 * What a pool's usage history says about one provider it runs, at the pace
 * of the last week: when every account runs out, and how many more accounts
 * of that provider would carry it through the next week. For pool admins:
 * it rests on how many accounts the pool has.
 */
/** Less than a day of history says nothing about a pool's daily rhythm, so there's no forecast yet. */
export const POOL_ADVICE_MIN_HISTORY_HOURS = 24;

export const AccountPoolProviderAdvice = Schema.Struct({
  driver: ProviderDriverKind,
  /** Hours of history behind it; under a day there is no forecast yet. */
  historyHours: NonNegativeInt,
  /** The first moment in the next week when no account has quota left. */
  runsOut: Schema.optional(
    Schema.Struct({
      at: IsoDateTime,
      /** The window that runs out, as the provider labels it. */
      window: Schema.String,
      /** When a reset next hands an account back, if one does. */
      backAt: Schema.optional(IsoDateTime),
    }),
  ),
  /** Accounts of this provider to add so it doesn't run out; 0 when it already lasts. */
  addAccounts: NonNegativeInt,
});
export type AccountPoolProviderAdvice = typeof AccountPoolProviderAdvice.Type;

export const AccountPoolAdvice = Schema.Struct({
  poolId: AccountPoolId,
  providers: Schema.Array(AccountPoolProviderAdvice),
});
export type AccountPoolAdvice = typeof AccountPoolAdvice.Type;

/**
 * API keys a pool takes. The hub routes every kind but Cursor, whose key is
 * handed to the pool's Cursor provider per turn instead.
 */
const POOL_API_KEY_PROVIDERS = [
  "anthropic",
  "openai",
  "xai",
  "gemini",
  "openrouter",
  "openai-compatible",
  "cursor",
] as const;
export const PoolApiKeyProvider = Schema.Literals(POOL_API_KEY_PROVIDERS);
export type PoolApiKeyProvider = typeof PoolApiKeyProvider.Type;

export const AccountPoolAddApiKeyInput = Schema.Struct({
  poolId: AccountPoolId,
  provider: PoolApiKeyProvider,
  apiKey: HubKey,
  /** Required for `openai-compatible`: where the endpoint answers, such as `https://host/v1`. */
  baseUrl: Schema.optional(HubUrl),
});
export type AccountPoolAddApiKeyInput = typeof AccountPoolAddApiKeyInput.Type;

/**
 * Moves the logins of provider instances that sign in on the server machine
 * (native logins) into a pool. Each instance is turned off once its login is
 * in the pool, so the pool is the only place that refreshes it.
 */
export const AccountPoolMoveNativeLoginsInput = Schema.Struct({
  poolId: AccountPoolId,
  instanceIds: Schema.Array(ProviderInstanceId).check(Schema.isMinLength(1)),
});
export type AccountPoolMoveNativeLoginsInput = typeof AccountPoolMoveNativeLoginsInput.Type;

export const AccountPoolMoveNativeLoginsResult = Schema.Struct({
  moved: Schema.Array(ProviderInstanceId),
  failed: Schema.Array(Schema.Struct({ instanceId: ProviderInstanceId, reason: Schema.String })),
});
export type AccountPoolMoveNativeLoginsResult = typeof AccountPoolMoveNativeLoginsResult.Type;

export const AccountPoolSetOpenCodeInput = Schema.Struct({
  poolId: AccountPoolId,
  enabled: Schema.Boolean,
});
export type AccountPoolSetOpenCodeInput = typeof AccountPoolSetOpenCodeInput.Type;

/**
 * The provider instances a pool runs: one per kind of account it holds, plus
 * OpenCode when turned on. Adding the first account of a kind adds that kind's
 * instance, so the model picker never grows a row per account.
 */
export const POOL_INSTANCE_KINDS = {
  codex: { driver: ProviderDriverKind.make("codex"), displayName: "ChatGPT" },
  claude: { driver: ProviderDriverKind.make("claudeAgent"), displayName: "Claude" },
  grok: { driver: ProviderDriverKind.make("grok"), displayName: "Grok" },
  antigravity: { driver: ProviderDriverKind.make("antigravity"), displayName: "Antigravity" },
  cursor: { driver: ProviderDriverKind.make("cursor"), displayName: "Cursor" },
  opencode: { driver: ProviderDriverKind.make("opencode"), displayName: "OpenCode" },
} as const;
export type PoolInstanceKind = keyof typeof POOL_INSTANCE_KINDS;

/**
 * What a pool can do: sign in an account of one of these kinds, take an API
 * key, import accounts from a CLIProxyAPI, run OpenCode, or advise from its
 * usage history.
 */
export const PoolFeature = Schema.Literals([
  "codex",
  "claude",
  "grok",
  "antigravity",
  "cursor",
  "api-key",
  "import",
  "opencode",
  "advice",
]);
export type PoolFeature = typeof PoolFeature.Type;

/** Drivers whose native login can move into a pool. */
export const MOVABLE_NATIVE_DRIVERS: ReadonlyArray<ProviderDriverKind> = [
  POOL_INSTANCE_KINDS.claude.driver,
  POOL_INSTANCE_KINDS.codex.driver,
  POOL_INSTANCE_KINDS.cursor.driver,
];

/** Drivers a pool can run: a signed-out one is fixed by adding an account to its pool. */
export const POOL_DRIVERS: ReadonlyArray<ProviderDriverKind> = Object.values(
  POOL_INSTANCE_KINDS,
).map((kind) => kind.driver);

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

/**
 * The provider instance id of a pool's instance for one kind (`codex`,
 * `claude`, `grok`, `antigravity`, `cursor`, `opencode`).
 */
export const poolInstanceId = (kind: string, poolId: string) =>
  poolId === PERSONAL_POOL_ID ? `${kind}_hub` : `${kind}_hub_${poolId}`;

/**
 * The instance of `kind` in a pool, ready to save. Outside the personal pool
 * it carries the pool's name, so the picker can tell pools apart.
 */
export function poolInstanceEntry(
  kind: PoolInstanceKind,
  pool: { readonly id: string; readonly name: string | undefined },
): readonly [ProviderInstanceId, ProviderInstanceConfig] {
  const { driver, displayName } = POOL_INSTANCE_KINDS[kind];
  const personal = pool.id === PERSONAL_POOL_ID;
  return [
    ProviderInstanceId.make(poolInstanceId(kind, pool.id)),
    {
      driver,
      displayName: personal || !pool.name ? displayName : `${displayName} · ${pool.name}`,
      enabled: true,
      config: { enabled: true, setupMode: "hub", ...(personal ? {} : { poolId: pool.id }) },
    },
  ];
}
