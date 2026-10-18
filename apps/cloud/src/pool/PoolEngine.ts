import type {
  ServerProviderUsageLimits,
  UsageLimitSourceUpdateAccountInput,
} from "@t3tools/contracts";
import {
  type AccountPoolSetRoutingInput,
  type AccountPoolProviderAdvice,
  DEFAULT_POOL_ROUTING,
  isCloudPoolAccountType,
  POOL_LINK_PATH,
  PoolRouting,
  type PoolLinkInfo,
  type PoolLinkMoveRequest,
  type PoolLinkMoveResult,
} from "@t3tools/contracts/accountHub";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import { takesTurns } from "@t3tools/shared/poolUsage";
import type { SqlError } from "effect/sql/SqlError";

import * as Migrations from "../storage/migrations.ts";
import type { ModelCallTrace } from "../models/ModelProtocol.ts";
import * as CliProxyApi from "./cliProxyApi.ts";
import * as PoolContainer from "./PoolContainer.ts";
import { unknownRelease } from "./CliProxyApiRuntime.ts";
import { observePoolCall, PoolTelemetry } from "./PoolTelemetry.ts";
import * as PoolLimits from "./poolLimits.ts";
import * as PoolLinks from "./PoolLinks.ts";
import * as PoolModels from "./poolModels.ts";
import * as PoolUsageHistory from "./poolUsageHistory.ts";
import * as PoolStore from "./poolStore.ts";
import * as ThreadAccounts from "./threadAccounts.ts";

/**
 * Everything one pool's Durable Object owns: the pool record, who may use it
 * (grants), the accounts its CLIProxyAPI holds and who contributed each, and
 * an admin audit log. The CLIProxyAPI is the pool's own container, reading
 * and writing its credentials in this object's store (`poolStore.ts`), or one
 * the pool's admin runs. Either way this object is the only thing that talks
 * to it, so it is the single writer for the pool's rotating refresh tokens.
 *
 * Callers are trusted code (the Worker and user objects) acting for a user;
 * every call names that user and is checked against the grants.
 */

export interface PoolActor {
  readonly userId: string;
}

export type PoolRole = "admin" | "member";

export type PoolBacking =
  | { readonly mode: "managed" }
  | { readonly mode: "external"; readonly url: string };

export interface PoolInfo {
  readonly name: string;
  readonly personal: boolean;
  readonly backing: PoolBacking;
  readonly role: PoolRole;
  /** How it spreads turns; only for its admins, and only where Signalbox runs its CLIProxyAPI. */
  readonly routing: PoolRouting | null;
}

export interface PoolAccount extends CliProxyApi.BackendAccount {
  /** The user who signed it in, when it came in through this pool. */
  readonly contributedBy: string | null;
  /** Its windows as last read (`poolLimits.ts`), or null before the first read. */
  readonly usageLimits: ServerProviderUsageLimits | null;
}

/** An account as the pool caches it, before its windows are joined in. */
type CachedAccount = Omit<PoolAccount, "usageLimits">;

export interface PoolAccounts {
  /** The reader's role: per-account detail is for admins, members see the pooled view. */
  readonly role: PoolRole;
  /** How it spreads turns, for admins of a pool Signalbox runs (`PoolInfo.routing`). */
  readonly routing: PoolRouting | null;
  readonly checkedAt: number;
  readonly accounts: ReadonlyArray<PoolAccount>;
  /** Why the latest read failed; `accounts` is then the last known list. */
  readonly error: string | null;
  /** The models the accounts serve, as last read with them. */
  readonly models: ReadonlyArray<CliProxyApi.ServedModel>;
}

export type PoolBackingInput =
  | { readonly mode: "managed" }
  | {
      readonly mode: "external";
      readonly url: string;
      readonly managementKey: string;
      readonly clientKey: string;
    };

export type AccountAction = UsageLimitSourceUpdateAccountInput["action"];

/** A refusal the caller can show as is. */
export class PoolRejectedError extends Schema.TaggedError<PoolRejectedError>()(
  "PoolRejectedError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

/** How the pool reaches an admin's own CLIProxyAPI on the internet. */
export class ExternalFetch extends Context.Service<
  ExternalFetch,
  { readonly fetch: (request: Request) => Promise<Response> }
>()("@signalbox/cloud/pool/PoolEngine/ExternalFetch") {}

export const layerExternalFetch = Layer.succeed(
  ExternalFetch,
  // @effect-diagnostics-next-line globalFetch:off - the Workers runtime's own fetch.
  ExternalFetch.of({ fetch: (request) => fetch(request) }),
);

type Failure = PoolRejectedError | CliProxyApi.PoolBackendError | SqlError;

export class PoolEngine extends Context.Service<
  PoolEngine,
  {
    readonly initialize: Effect.Effect<void, SqlError | Migrator.MigrationError>;
    /** Sets the pool up with `actor` as its admin. Repeating it as the owner changes nothing. */
    readonly create: (
      actor: PoolActor,
      input: { readonly name: string; readonly personal: boolean },
    ) => Effect.Effect<PoolInfo, Failure>;
    readonly info: (actor: PoolActor) => Effect.Effect<PoolInfo, Failure>;
    readonly rename: (actor: PoolActor, name: string) => Effect.Effect<PoolInfo, Failure>;
    /**
     * Changes how the pool spreads turns across its accounts, applied to its
     * CLIProxyAPI right away. Only for pools Signalbox runs.
     */
    readonly setRouting: (
      actor: PoolActor,
      change: AccountPoolSetRoutingInput["routing"],
    ) => Effect.Effect<PoolInfo, Failure>;
    readonly setBacking: (
      actor: PoolActor,
      backing: PoolBackingInput,
    ) => Effect.Effect<PoolInfo, Failure>;
    /**
     * Checks `actor` may delete the pool and stops its container; the object
     * then wipes itself. A pool already gone counts as deleted.
     */
    readonly prepareDelete: (actor: PoolActor) => Effect.Effect<void, Failure>;
    readonly accounts: (actor: PoolActor) => Effect.Effect<PoolAccounts, Failure>;
    readonly advice: (
      actor: PoolActor,
    ) => Effect.Effect<ReadonlyArray<AccountPoolProviderAdvice> | null, Failure>;
    /**
     * The models the pool serves, for the check at turn start. A pool whose
     * models were never attempted reads them now, waking its container: the
     * turn is about to anyway. Failed first reads back off for five minutes.
     */
    readonly models: (actor: PoolActor) => Effect.Effect<PoolModels.PoolModels, Failure>;
    /** Reads the last catalog without refreshing it, for a pool link's metadata endpoint. */
    readonly cachedModels: (actor: PoolActor) => Effect.Effect<PoolModels.PoolModels, Failure>;
    /** Refreshes a stale catalog from an alarm, waking a managed pool for this read. */
    readonly refreshModelsAtAlarm: () => Effect.Effect<void, SqlError>;
    /** The next catalog refresh alarm for a pool with accounts or an external backing. */
    readonly nextModelsRefreshAt: () => Effect.Effect<number | null, SqlError>;
    readonly refreshUsageAtAlarm: () => Effect.Effect<void, SqlError>;
    readonly nextUsageSampleAt: () => Effect.Effect<number | null, SqlError>;
    readonly startLogin: (
      actor: PoolActor,
      provider: CliProxyApi.PoolLoginProvider,
      flow?: CliProxyApi.PoolLoginFlow,
    ) => Effect.Effect<CliProxyApi.LoginStart, Failure>;
    readonly loginStatus: (
      actor: PoolActor,
      state: string,
    ) => Effect.Effect<CliProxyApi.LoginStatus, Failure>;
    readonly completeLogin: (
      actor: PoolActor,
      callback: CliProxyApi.LoginCallback,
    ) => Effect.Effect<void, Failure>;
    readonly cancelLogin: (actor: PoolActor, state: string) => Effect.Effect<boolean, Failure>;
    readonly logoutAccount: (
      actor: PoolActor,
      provider: CliProxyApi.PoolLoginProvider,
      name: string,
    ) => Effect.Effect<void, Failure>;
    readonly updateAccount: (
      actor: PoolActor,
      name: string,
      action: AccountAction,
    ) => Effect.Effect<void, Failure>;
    /**
     * A link for a server moving its own pool here (`PoolLinks.ts`). Answers its
     * secret. With `preview`, a preview link for that origin.
     */
    readonly openLink: (
      actor: PoolActor,
      preview?: { readonly origin: string },
    ) => Effect.Effect<string, Failure>;
    /** The pool's name and accounts, as a linked server sees them. */
    readonly linkInfo: (actor: PoolActor) => Effect.Effect<PoolLinkInfo, Failure>;
    /**
     * Saves credential files another hub held (a pool moving here). Names the
     * pool already holds are skipped; if any file fails, the ones this call
     * saved are removed again, so a failed move leaves nothing behind.
     */
    readonly importAccounts: (
      actor: PoolActor,
      accounts: PoolLinkMoveRequest["accounts"],
    ) => Effect.Effect<PoolLinkMoveResult, Failure>;
    /**
     * A model request from a turn `actor` runs, sent to the pool's
     * CLIProxyAPI. Checked against the grants on every request, so losing
     * access stops the next one. `upstreamMs`: from handing it to the
     * CLIProxyAPI to its response headers. A request naming its `thread`
     * stays on that thread's account (`threadAccounts.ts`); `accountMoved`
     * says when it had to leave it.
     */
    readonly forwardModel: (
      actor: PoolActor,
      path: string,
      request: Request,
      thread?: string,
      trace?: ModelCallTrace,
    ) => Effect.Effect<
      {
        readonly response: Response;
        readonly upstreamMs: number;
        readonly accountMoved: string | null;
      },
      Failure
    >;
    /** A request from the pool's container to its store. */
    readonly storeRequest: (request: Request) => Effect.Effect<Response, SqlError>;
  }
>()("@signalbox/cloud/pool/PoolEngine") {}

const migrations = Migrator.fromRecord({
  "0001_pool": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // One row. Keys are generated here and never leave the object.
    yield* sql`CREATE TABLE pool (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      personal INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      backing TEXT NOT NULL,
      management_key TEXT NOT NULL,
      client_key TEXT NOT NULL,
      store_access_key TEXT NOT NULL,
      store_secret_key TEXT NOT NULL,
      external_url TEXT,
      external_management_key TEXT,
      external_client_key TEXT
    )`;
    yield* sql`CREATE TABLE grants (
      user_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      granted_at INTEGER NOT NULL
    )`;
    // The last account list read from the CLIProxyAPI, so reading the pool
    // never wakes a sleeping container.
    yield* sql`CREATE TABLE accounts (
      name TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      email TEXT,
      disabled INTEGER NOT NULL,
      signed_out INTEGER NOT NULL,
      contributed_by TEXT,
      added_at INTEGER NOT NULL
    )`;
    yield* sql`CREATE TABLE accounts_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      checked_at INTEGER NOT NULL,
      error TEXT
    )`;
    yield* sql`INSERT INTO accounts_state (id, checked_at, error) VALUES (1, 0, NULL)`;
    // Sign-ins in flight: who started each, and which accounts existed before it.
    yield* sql`CREATE TABLE logins (
      state TEXT PRIMARY KEY,
      started_by TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      known TEXT NOT NULL
    )`;
    yield* sql`CREATE TABLE audit (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT
    )`;
    yield* PoolStore.createTables;
  }),
  "0002_links": PoolLinks.createTables,
  "0003_preview_links": PoolLinks.addPreviewLinks,
  "0004_models": PoolModels.createTables,
  "0005_managed_config": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The managed config last patched into a managed pool's CLIProxyAPI, as JSON.
    yield* sql`CREATE TABLE managed_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      applied TEXT
    )`;
    yield* sql`INSERT INTO managed_config (id, applied) VALUES (1, NULL)`;
  }),
  "0006_account_limits": PoolLimits.createTables,
  "0007_routing": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The admins' `PoolRouting` as JSON; null runs `DEFAULT_POOL_ROUTING`.
    yield* sql`ALTER TABLE managed_config ADD COLUMN routing TEXT`;
  }),
  "0008_thread_accounts": ThreadAccounts.createTables,
  "0009_model_metadata": PoolModels.addMetadata,
  "0010_usage_history": PoolUsageHistory.createTables,
  "0011_usage_sampling": PoolUsageHistory.addSampling,
  "0012_account_logout": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE logged_out_accounts (name TEXT PRIMARY KEY)`;
  }),
  "0013_pending_account_logout": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE logged_out_accounts ADD COLUMN pending INTEGER NOT NULL DEFAULT 0`;
  }),
});

/** Applies every migration not recorded yet (`storage/migrations.ts`). Never edit or rename a merged one. */
const migrate = Migrations.run(migrations);

interface PoolRow {
  readonly name: string;
  readonly personal: number;
  readonly backing: string;
  readonly management_key: string;
  readonly client_key: string;
  readonly store_access_key: string;
  readonly store_secret_key: string;
  readonly external_url: string | null;
  readonly external_management_key: string | null;
  readonly external_client_key: string | null;
}

interface AccountRow {
  readonly name: string;
  readonly type: string;
  readonly email: string | null;
  readonly disabled: number;
  readonly signed_out: number;
  readonly contributed_by: string | null;
}

/** How long a pool waits after a failed managed config change before trying again. */
const MANAGED_CONFIG_RETRY_MS = 5 * 60_000;

/** How old the account list may get before a read asks the CLIProxyAPI again. */
export const ACCOUNTS_FRESH_MS = 30_000;

/** A passive account snapshot never waits on an unbounded pool or provider read. */
export const ACCOUNTS_READ_TIMEOUT_MS = 750;

/** A stuck upstream request must release the shared refresh so polling can retry. */
export const ACCOUNTS_REFRESH_TIMEOUT_MS = 120_000;

const ACCOUNTS_READ_TIMEOUT_MESSAGE =
  "The pool did not refresh its account snapshot in time. Try again shortly.";

/** CLIProxyAPI refreshes its model registry every three hours. */
export const MODELS_REFRESH_MS = 3 * 60 * 60_000;

/** A failed catalog read may retry after five minutes, not on every read or alarm. */
const MODELS_REFRESH_RETRY_MS = 5 * 60_000;

/** The account names a sign-in started with. */
const KnownAccounts = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeKnown = Schema.encodeSync(KnownAccounts);
const decodeKnown = Schema.decodeUnknownSync(KnownAccounts);

const reject = (reason: string) => Effect.fail(new PoolRejectedError({ reason }));

const RoutingJson = Schema.fromJsonString(PoolRouting);
const encodeRouting = Schema.encodeSync(RoutingJson);
const decodeRoutingOption = Schema.decodeUnknownOption(RoutingJson);
/** A stored routing the schema no longer reads falls back to the default. */
const decodeRouting = (json: string) =>
  Option.getOrElse(decodeRoutingOption(json), () => DEFAULT_POOL_ROUTING);

/** Who the audit log names for what the pool does on its own. */
const POOL_ITSELF: PoolActor = { userId: "pool" };

const backingOf = (row: PoolRow): PoolBacking =>
  row.backing === "external" && row.external_url !== null
    ? { mode: "external", url: row.external_url }
    : { mode: "managed" };

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/u, "");

/**
 * A pool backed by another cloud's pool link (a preview routing through
 * production's pool) holds no accounts of its own: they're added and managed
 * where the pool lives.
 */
const isPoolLinkUrl = (url: string | null) => url?.endsWith(POOL_LINK_PATH) === true;

const refuseIfLinked = (row: PoolRow) => {
  if (row.backing !== "external" || row.external_url === null || !isPoolLinkUrl(row.external_url)) {
    return Effect.void;
  }
  return reject(
    `This pool is linked to ${new URL(row.external_url).host}. Add and manage its accounts there.`,
  );
};

/** The account file names a hub writes; never a hidden file. */
const ACCOUNT_FILE_NAME = /^[\w@+-][\w.@+-]*\.json$/u;
const decodeCredential = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** How many account files a move writes or removes at once. */
const MOVE_CONCURRENCY = 4;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* PoolStore.PoolStore;
  const container = yield* PoolContainer.PoolContainer;
  const external = yield* ExternalFetch;
  const telemetry = yield* PoolTelemetry;
  const crypto = yield* Crypto.Crypto;
  const links = yield* PoolLinks.PoolLinks;
  const randomKey = PoolLinks.randomKey.pipe(Effect.provideService(Crypto.Crypto, crypto));
  const withSql = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
    Effect.provideService(effect, SqlClient.SqlClient, sql);
  const cachedModels = withSql(PoolModels.cached);

  const poolRow = sql<PoolRow>`SELECT name, personal, backing, management_key, client_key,
    store_access_key, store_secret_key, external_url, external_management_key,
    external_client_key FROM pool WHERE id = 1`.pipe(Effect.map(([row]) => row ?? null));

  const audit = (actor: PoolActor, action: string, detail: string | null = null) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO audit (at, actor, action, detail)
        VALUES (${at}, ${actor.userId}, ${action}, ${detail})`;
    });

  /**
   * The pool row and the actor's role, when they hold at least `needed`.
   * `reasons` words a missing pool or grant for where the refusal shows.
   */
  const access = (
    actor: PoolActor,
    needed: PoolRole,
    reasons = {
      gone: "This pool no longer exists.",
      denied: "You don't have access to this pool.",
    },
  ) =>
    Effect.gen(function* () {
      const row = yield* poolRow;
      if (row === null) return yield* reject(reasons.gone);
      const [grant] = yield* sql<{
        readonly role: PoolRole;
      }>`SELECT role FROM grants WHERE user_id = ${actor.userId}`;
      if (grant === undefined) return yield* reject(reasons.denied);
      if (needed === "admin" && grant.role !== "admin") {
        return yield* reject("Only the pool's admins can do that.");
      }
      return { row, role: grant.role };
    });

  /** The routing `role` may see and change: an admin's, on a pool Signalbox runs. */
  const routingFor = (row: PoolRow, role: PoolRole) =>
    role === "admin" && row.backing !== "external" ? routingOf : Effect.succeed(null);

  const infoOf = (row: PoolRow, role: PoolRole) =>
    Effect.map(routingFor(row, role), (routing): PoolInfo => ({
      name: row.name,
      personal: row.personal === 1,
      backing: backingOf(row),
      role,
      routing,
    }));

  /**
   * Where the pool's CLIProxyAPI answers. `passive` reads reach a managed
   * pool's container only while it is up anyway, and never keep it up.
   * `onSend` runs as a request goes to the CLIProxyAPI, after any cold start.
   * `models`: a model request on a pool with accounts, which a cold start
   * holds until CLIProxyAPI serves their models (`PoolContainer.SendOptions`).
   */
  const endpointOf = (
    row: PoolRow,
    options?: {
      readonly passive?: true;
      readonly onSend?: () => void;
      readonly models?: true;
      readonly actor?: PoolActor;
      readonly thread?: string;
      readonly trace?: ModelCallTrace;
    },
  ): CliProxyApi.PoolEndpoint => {
    const remote =
      row.backing === "external" &&
      row.external_url !== null &&
      row.external_management_key !== null &&
      row.external_client_key !== null;
    const endpoint = remote
      ? {
          baseUrl: row.external_url,
          managementKey: row.external_management_key,
          clientKey: row.external_client_key,
          link: isPoolLinkUrl(row.external_url),
        }
      : {
          baseUrl: PoolContainer.CONTAINER_ORIGIN,
          managementKey: row.management_key,
          clientKey: row.client_key,
          link: false,
        };
    return {
      ...endpoint,
      fetch: (request) =>
        observePoolCall({
          request,
          baseUrl: endpoint.baseUrl,
          backing: endpoint.link ? "linked" : remote ? "external" : "managed",
          release: remote ? () => unknownRelease : container.release,
          correlation: {
            ...(options?.actor && { person: { id: options.actor.userId } }),
            // Link affinity is caller-supplied; only the model authority supplies a trace.
            ...(options?.trace && {
              ...(options.thread && { thread: { id: options.thread } }),
              turn: { id: options.trace.runId, traceId: options.trace.traceId },
            }),
          },
          submit: telemetry.submit,
          send: (onSend) => {
            const sending = () => {
              onSend();
              options?.onSend?.();
            };
            if (remote) {
              sending();
              return external.fetch(request);
            }
            if (options?.passive) {
              sending();
              return container.peek(request);
            }
            return container.fetch(request, {
              store: { accessKey: row.store_access_key, secretKey: row.store_secret_key },
              onSend: sending,
              ...(options?.models ? { models: { clientKey: row.client_key } } : {}),
            });
          },
        }),
    };
  };

  /** The routing the pool's admins chose, or the default. */
  const routingOf = sql<{
    readonly routing: string | null;
  }>`SELECT routing FROM managed_config WHERE id = 1`.pipe(
    Effect.map(([state]) =>
      state?.routing == null ? DEFAULT_POOL_ROUTING : decodeRouting(state.routing),
    ),
  );

  /**
   * This object's view of the managed config: applied, or when to try again.
   * Kept in memory so model requests skip the check once it's applied.
   */
  const managedConfigState = { applied: false, retryAt: 0 };
  const applyingManagedConfig = yield* Semaphore.make(1);

  /** Patches the managed config into the CLIProxyAPI unless it already runs it. */
  const applyManagedConfig = (endpoint: CliProxyApi.PoolEndpoint) =>
    Effect.gen(function* () {
      const routing = yield* routingOf;
      const desired = CliProxyApi.managedConfigJson(routing);
      const [state] = yield* sql<{
        readonly applied: string | null;
      }>`SELECT applied FROM managed_config WHERE id = 1`;
      if (state?.applied !== desired) {
        yield* CliProxyApi.applyManagedConfig(endpoint, routing);
        yield* sql`UPDATE managed_config SET applied = ${desired} WHERE id = 1`;
        yield* Effect.logInfo("pool managed config applied").pipe(
          Effect.annotateLogs({
            "routing.strategy": routing.strategy,
            "routing.session_affinity": routing.sessionAffinity,
            "routing.move_on": routing.moveOn,
          }),
        );
      }
      managedConfigState.applied = true;
    }).pipe(applyingManagedConfig.withPermits(1));

  /**
   * Brings a managed pool's CLIProxyAPI up to its managed config: a pool
   * created before a setting was added gets it on its next request, and one
   * that missed a routing change catches up. Never fails the request it runs
   * before; a failed patch waits `MANAGED_CONFIG_RETRY_MS` before the next.
   */
  const ensureManagedConfig = (endpoint: CliProxyApi.PoolEndpoint) =>
    Effect.gen(function* () {
      if (managedConfigState.applied || endpoint.baseUrl !== PoolContainer.CONTAINER_ORIGIN) return;
      const now = yield* Clock.currentTimeMillis;
      if (now < managedConfigState.retryAt) return;
      yield* applyManagedConfig(endpoint).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            managedConfigState.retryAt = now + MANAGED_CONFIG_RETRY_MS;
          }),
        ),
      );
    }).pipe(
      Effect.catchTags({
        PoolBackendError: (error) =>
          Effect.logWarning("pool managed config not applied", error.detail, error.cause),
        SqlError: (cause) => Effect.logWarning("pool managed config not recorded", { cause }),
      }),
    );

  const accountChanges = yield* Semaphore.make(1);
  const cachedAccounts = Effect.gen(function* () {
    const rows = yield* sql<AccountRow>`SELECT name, type, email, disabled, signed_out,
      contributed_by FROM accounts ORDER BY added_at, name`;
    const [state] = yield* sql<{
      readonly checked_at: number;
      readonly error: string | null;
    }>`SELECT checked_at, error FROM accounts_state WHERE id = 1`;
    const { models } = yield* cachedModels;
    return {
      checkedAt: state?.checked_at ?? 0,
      error: state?.error ?? null,
      models,
      accounts: rows.map((row): CachedAccount => ({
        name: row.name,
        type: row.type,
        email: row.email,
        disabled: row.disabled === 1,
        signedOut: row.signed_out === 1,
        contributedBy: row.contributed_by,
      })),
    };
  });

  /** Stores the account list without claiming a foreground snapshot or quota read completed. */
  const storeAccountRows = (
    live: ReadonlyArray<CliProxyApi.ListedAccount>,
    cached: ReadonlyArray<CachedAccount>,
    now: number,
    contributors: (name: string) => string | null = () => null,
  ) =>
    Effect.gen(function* () {
      const known = new Map(cached.map((account) => [account.name, account]));
      for (const account of live) {
        // A fresh credential for this name completes reauthentication.
        yield* sql`DELETE FROM logged_out_accounts WHERE name = ${account.name} AND pending = 0`;
        const before = known.get(account.name);
        if (
          before !== undefined &&
          before.type === account.type &&
          before.email === account.email &&
          before.disabled === account.disabled &&
          before.signedOut === account.signedOut
        )
          continue;
        const contributor = before === undefined ? contributors(account.name) : null;
        yield* sql`INSERT INTO accounts (name, type, email, disabled, signed_out,
          contributed_by, added_at)
        VALUES (${account.name}, ${account.type}, ${account.email},
          ${account.disabled ? 1 : 0}, ${account.signedOut ? 1 : 0}, ${contributor}, ${now})
        ON CONFLICT (name) DO UPDATE SET type = excluded.type, email = excluded.email,
          disabled = excluded.disabled, signed_out = excluded.signed_out`;
      }
      const names = new Set(live.map((account) => account.name));
      for (const account of cached) {
        if (!names.has(account.name))
          yield* sql`DELETE FROM accounts WHERE name = ${account.name}
            AND name NOT IN (SELECT name FROM logged_out_accounts)`;
      }
    });

  const threadAccounts = ThreadAccounts.make({
    sql,
    audit: (detail) => audit(POOL_ITSELF, "move-thread", detail),
  });

  const readingLimits = yield* Semaphore.make(1);
  const accountSnapshotReadLock = yield* Semaphore.make(1);
  let accountSnapshotReadFiber: Fiber.Fiber<void, never> | null = null;

  /**
   * Reads the accounts' windows after their list (`poolLimits.ts`), one read
   * at a time so an account is never probed twice, and records every
   * cooldown that read ended. Never fails the list.
   */
  const refreshLimits = (
    endpoint: CliProxyApi.PoolEndpoint,
    live: ReadonlyArray<CliProxyApi.ListedAccount>,
    now: number,
    mode: PoolLimits.ReadMode,
  ) =>
    withSql(PoolLimits.refresh(endpoint, live, now, mode)).pipe(
      Effect.tap((cleared) =>
        Effect.forEach(
          cleared,
          (each) =>
            audit(POOL_ITSELF, "clear-cooldown", `${each.name}: ${each.reason}`).pipe(
              // A wide event: what happened and how much waiting it saved, never who or what.
              Effect.andThen(
                Effect.logInfo("pool cooldown cleared").pipe(
                  Effect.annotateLogs({
                    "account.type": each.type,
                    "cooldown.held_for_minutes": Math.round(each.heldForMs / 60_000),
                  }),
                ),
              ),
            ),
          { discard: true },
        ),
      ),
      readingLimits.withPermits(1),
      Effect.catchTags({
        SqlError: (cause) => Effect.logWarning("pool limits not stored", { cause }),
      }),
    );

  /** When a rate limit last made the pool check its held accounts (`checkHeldAccounts`). */
  const heldCheck = { at: 0 };

  /**
   * After a model request came back rate limited: checks only the accounts
   * the CLIProxyAPI holds with their providers, and lets go of those with
   * room again. Clients retry, so a stale cooldown ends within
   * `HELD_CHECK_MS` of the next attempt with nobody touching the pool. At
   * most once per `HELD_CHECK_MS`; its probes are bounded on their own, and
   * it never fails the response it follows.
   */
  const checkHeldAccounts = (row: PoolRow) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now - heldCheck.at < PoolLimits.HELD_CHECK_MS) return;
      heldCheck.at = now;
      const endpoint = endpointOf(row, { passive: true });
      const live = yield* CliProxyApi.listAccounts(endpoint);
      yield* refreshLimits(endpoint, live, now, "held");
    }).pipe(
      Effect.withSpan("PoolEngine.checkHeldAccounts"),
      Effect.catch((cause) => Effect.logWarning("pool held account check failed", { cause })),
    );

  /**
   * Reads the CLIProxyAPI's accounts into the cache, keeping who contributed
   * each, and writes only what changed. `contributors` names the contributor
   * of accounts new to the cache. Passive reads, and reads with `probe`, may
   * ask the providers for windows the pool doesn't know (`poolLimits.ts`);
   * admin actions don't wait on that.
   */
  const refreshAccounts = (
    row: PoolRow,
    contributors: (name: string) => string | null = () => null,
    options?: { readonly passive?: true; readonly probe?: true },
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const endpoint = endpointOf(row, options);
      yield* ensureManagedConfig(endpoint);
      const live = yield* Effect.gen(function* () {
        const live = yield* CliProxyApi.listAccounts(endpoint).pipe(
          Effect.catchTags({
            PoolBackendError: (error) =>
              sql`UPDATE accounts_state SET checked_at = ${now}, error = ${error.detail}
                WHERE id = 1`.pipe(Effect.andThen(Effect.fail(error))),
          }),
        );
        const cached = yield* cachedAccounts;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* storeAccountRows(live, cached.accounts, now, contributors);
            yield* sql`UPDATE accounts_state SET checked_at = ${now}, error = NULL WHERE id = 1`;
          }),
        );
        return live;
      }).pipe(accountChanges.withPermits(1));
      const mode: PoolLimits.ReadMode =
        options?.passive === true || options?.probe === true ? "probe" : "free";
      // Account freshness must not wait for model discovery or provider usage probes.
      yield* CliProxyApi.listModels(endpoint).pipe(
        Effect.flatMap((models) => withSql(PoolModels.store(models, now))),
        Effect.catchTags({
          PoolBackendError: (error) =>
            Effect.logWarning("pool model list read failed", error.detail, error.cause).pipe(
              Effect.andThen(withSql(PoolModels.markTried(now))),
            ),
        }),
      );
      yield* refreshLimits(endpoint, live, now, mode);
      return live;
    });

  const create: PoolEngine["Service"]["create"] = (actor, input) =>
    Effect.gen(function* () {
      const existing = yield* poolRow;
      if (existing !== null) {
        const { row, role } = yield* access(actor, "admin");
        return yield* infoOf(row, role);
      }
      const now = yield* Clock.currentTimeMillis;
      const managementKey = yield* randomKey;
      const clientKey = yield* randomKey;
      const storeAccessKey = yield* randomKey;
      const storeSecretKey = yield* randomKey;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO pool (id, name, personal, created_at, backing, management_key,
              client_key, store_access_key, store_secret_key)
            VALUES (1, ${input.name}, ${input.personal ? 1 : 0}, ${now}, 'managed',
              ${managementKey}, ${clientKey}, ${storeAccessKey}, ${storeSecretKey})`;
          yield* sql`INSERT INTO grants (user_id, role, granted_at)
            VALUES (${actor.userId}, 'admin', ${now})`;
          yield* store.put(
            PoolStore.CONFIG_KEY,
            CliProxyApi.renderConfig({ managementKey, clientKey }),
          );
          yield* sql`UPDATE managed_config
            SET applied = ${CliProxyApi.managedConfigJson(DEFAULT_POOL_ROUTING)} WHERE id = 1`;
          yield* audit(actor, "create", input.name);
        }),
      );
      const { row, role } = yield* access(actor, "admin");
      return yield* infoOf(row, role);
    });

  const info: PoolEngine["Service"]["info"] = (actor) =>
    Effect.flatMap(access(actor, "member"), ({ row, role }) => infoOf(row, role));

  const setRouting: PoolEngine["Service"]["setRouting"] = (actor, change) =>
    Effect.gen(function* () {
      const { row, role } = yield* access(actor, "admin");
      if (row.backing === "external") {
        return yield* reject(
          isPoolLinkUrl(row.external_url)
            ? `This pool is linked to ${new URL(row.external_url!).host}. Change its load balancing there.`
            : "This pool runs on your own CLIProxyAPI. Set its routing in that CLIProxyAPI's config.",
        );
      }
      const current = yield* routingOf;
      const routing: PoolRouting = {
        strategy: change.strategy ?? current.strategy,
        sessionAffinity: change.sessionAffinity ?? current.sessionAffinity,
        moveOn: change.moveOn ?? current.moveOn,
      };
      yield* sql`UPDATE managed_config SET routing = ${encodeRouting(routing)} WHERE id = 1`;
      yield* audit(
        actor,
        "set-routing",
        `${routing.strategy}, affinity ${routing.sessionAffinity ? "on" : "off"}, move on ${routing.moveOn}`,
      );
      // Applied now if the pool is up; otherwise the request that wakes it applies
      // it first. Either way it holds from the next request, and a click never wakes it.
      managedConfigState.applied = false;
      managedConfigState.retryAt = 0;
      if (yield* container.running) yield* ensureManagedConfig(endpointOf(row, { passive: true }));
      return yield* infoOf(row, role);
    });

  const rename: PoolEngine["Service"]["rename"] = (actor, name) =>
    Effect.gen(function* () {
      yield* access(actor, "admin");
      yield* sql`UPDATE pool SET name = ${name} WHERE id = 1`;
      yield* audit(actor, "rename", name);
      return yield* info(actor);
    });

  const setBacking: PoolEngine["Service"]["setBacking"] = (actor, backing) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "admin");
      if (backing.mode === "managed") {
        yield* sql`UPDATE pool SET backing = 'managed', external_url = NULL,
          external_management_key = NULL, external_client_key = NULL WHERE id = 1`;
      } else {
        const url = normalizeUrl(backing.url);
        if (!/^https?:\/\//u.test(url)) return yield* reject("Use an http or https address.");
        const external = {
          ...row,
          backing: "external",
          external_url: url,
          external_management_key: backing.managementKey,
          external_client_key: backing.clientKey,
        };
        yield* CliProxyApi.checkKeys(endpointOf(external));
        yield* sql`UPDATE pool SET backing = 'external', external_url = ${url},
          external_management_key = ${backing.managementKey},
          external_client_key = ${backing.clientKey} WHERE id = 1`;
        // The managed container keeps its accounts in the store for switching back.
        yield* container.stop;
      }
      yield* sql`DELETE FROM accounts`;
      yield* sql`UPDATE accounts_state SET checked_at = 0, error = NULL WHERE id = 1`;
      yield* withSql(PoolModels.clear);
      yield* withSql(PoolLimits.clear);
      yield* audit(actor, "set-backing", backing.mode === "managed" ? "managed" : backing.url);
      const updated = yield* access(actor, "admin");
      // A managed pool's accounts come back when its container next wakes.
      if (updated.row.backing === "external") {
        yield* refreshAccounts(updated.row).pipe(Effect.ignore);
      }
      return yield* infoOf(updated.row, updated.role);
    });

  const prepareDelete: PoolEngine["Service"]["prepareDelete"] = (actor) =>
    Effect.gen(function* () {
      if ((yield* poolRow) === null) return;
      const { row } = yield* access(actor, "admin");
      if (row.personal === 1) return yield* reject("Your personal pool can't be deleted.");
      yield* container.stop;
    });

  /**
   * The first read of the models of a pool whose accounts were cached before
   * its models were (a pool from before the cache kept them). Wakes its
   * container; failed reads back off so a broken pool isn't woken on every look.
   */
  const firstModelsRead = (row: PoolRow) =>
    Effect.gen(function* () {
      const { accounts: held } = yield* cachedAccounts;
      const cached = yield* cachedModels;
      if (held.length === 0 || cached.checkedAt > 0) return;
      const now = yield* Clock.currentTimeMillis;
      if (cached.attemptedAt > 0 && now - cached.attemptedAt < MODELS_REFRESH_RETRY_MS) return;
      // Account-list failures happen before `refreshAccounts` reads models.
      yield* withSql(PoolModels.markAttempted(now));
      yield* refreshAccounts(row).pipe(
        Effect.tapError(() => withSql(PoolModels.markAttempted(now))),
      );
    });

  /** A read refresh outlives a caller that only waits for its deadline. */
  const refreshAccountSnapshot = (row: PoolRow) =>
    Effect.gen(function* () {
      yield* firstModelsRead(row).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("pool initial account snapshot refresh failed", { cause }),
        ),
      );
      const afterModels = yield* cachedAccounts;
      if ((yield* Clock.currentTimeMillis) - afterModels.checkedAt < ACCOUNTS_FRESH_MS) return;
      if (row.backing !== "external" && !(yield* container.running)) return;
      yield* refreshAccounts(row, undefined, { passive: true });
    }).pipe(
      Effect.timeoutOrElse({
        duration: ACCOUNTS_REFRESH_TIMEOUT_MS,
        orElse: () => Effect.logWarning("pool account snapshot refresh timed out"),
      }),
      Effect.catch((cause) => Effect.logWarning("pool account snapshot refresh failed", { cause })),
    );

  /** Starts or joins the one background read shared by accounts and linkInfo. */
  const accountSnapshotRead = (row: PoolRow) =>
    accountSnapshotReadLock.withPermits(1)(
      Effect.gen(function* () {
        const cached = yield* cachedAccounts;
        const models = yield* cachedModels;
        const now = yield* Clock.currentTimeMillis;
        const firstModelsReadDue =
          cached.accounts.length > 0 &&
          models.checkedAt === 0 &&
          (models.attemptedAt === 0 || now - models.attemptedAt >= MODELS_REFRESH_RETRY_MS);
        const canReadStaleAccounts = row.backing === "external" ? true : yield* container.running;
        const staleReadDue = now - cached.checkedAt >= ACCOUNTS_FRESH_MS && canReadStaleAccounts;
        if (!firstModelsReadDue && !staleReadDue) return null;
        if (accountSnapshotReadFiber !== null) return accountSnapshotReadFiber;

        // Publish the fiber before releasing the gate so concurrent RPCs can join it.
        const start = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkDetach(
          Deferred.await(start).pipe(
            Effect.andThen(refreshAccountSnapshot(row)),
            Effect.ensuring(
              accountSnapshotReadLock.withPermits(1)(
                Effect.sync(() => {
                  accountSnapshotReadFiber = null;
                }),
              ),
            ),
          ),
        );
        accountSnapshotReadFiber = fiber;
        yield* Deferred.succeed(start, undefined);
        return fiber;
      }),
    );

  /**
   * The cached accounts, read again once stale. Reading never wakes a sleeping
   * container or keeps one awake: an asleep pool's accounts are what it last
   * had. The one exception is `firstModelsRead`.
   */
  const cachedOrRead = (row: PoolRow) =>
    Effect.gen(function* () {
      const cached = yield* cachedAccounts;
      const fiber = yield* accountSnapshotRead(row);
      if (fiber === null) return yield* cachedAccounts.pipe(Effect.orElseSucceed(() => cached));
      const completed = yield* Fiber.join(fiber).pipe(
        Effect.as(true),
        Effect.timeoutOrElse({
          duration: ACCOUNTS_READ_TIMEOUT_MS,
          orElse: () => Effect.succeed(false),
        }),
      );
      if (completed) return yield* cachedAccounts.pipe(Effect.orElseSucceed(() => cached));
      // The account list may already have committed while its usage probes were slow.
      const after = yield* cachedAccounts;
      if (after.checkedAt > cached.checkedAt) return after;
      yield* sql`UPDATE accounts_state SET error = ${ACCOUNTS_READ_TIMEOUT_MESSAGE} WHERE id = 1`;
      return yield* cachedAccounts;
    });

  /** Whether a catalog can be refreshed without starting this pool's container. */
  const canRefreshModels = (row: PoolRow): Effect.Effect<boolean> =>
    row.backing === "external" ? Effect.succeed(row.external_url !== null) : container.running;

  const schedulesModels = (row: PoolRow) =>
    row.backing === "external"
      ? Effect.succeed(row.external_url !== null)
      : Effect.map(cachedAccounts, (cached) => cached.accounts.length > 0);

  const modelRefreshDue = (cached: PoolModels.PoolModels, now: number) => {
    if (cached.checkedAt > 0 && now - cached.checkedAt < MODELS_REFRESH_MS) return false;
    return cached.attemptedAt === 0 || now - cached.attemptedAt >= MODELS_REFRESH_RETRY_MS;
  };

  /** Alarm reads may cold-start a pool; ordinary reads stay passive. */
  const refreshModelCatalog = (row: PoolRow, wake = false) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      // Record the attempt first so a crash or failed response cannot cause an alarm loop.
      yield* withSql(PoolModels.markAttempted(now));
      const cold = wake && row.backing !== "external" && !(yield* container.running);
      const endpoint = endpointOf(row, cold ? { models: true } : { passive: true });
      if (cold) yield* ensureManagedConfig(endpoint);
      const models = endpoint.link
        ? yield* CliProxyApi.listPoolLinkModels(endpoint)
        : yield* CliProxyApi.listModels(endpoint);
      if (models === null) {
        yield* Effect.logWarning("linked pool model cache is unavailable");
        return;
      }
      yield* withSql(PoolModels.store(models, now));
    }).pipe(
      Effect.catchTags({
        PoolBackendError: (error) =>
          Effect.logWarning("pool model list refresh failed", error.detail, error.cause),
      }),
    );

  const refreshingModels = yield* Semaphore.make(1);
  const refreshModelsIfDue = (row: PoolRow, wake = false) =>
    refreshingModels.withPermits(1)(
      Effect.gen(function* () {
        const cached = yield* cachedModels;
        const now = yield* Clock.currentTimeMillis;
        if (modelRefreshDue(cached, now)) yield* refreshModelCatalog(row, wake);
      }),
    );

  /** The cached accounts with the windows last read for each. */
  const withLimits = (
    read: Omit<PoolAccounts, "role" | "routing" | "accounts"> & {
      readonly accounts: ReadonlyArray<CachedAccount>;
    },
  ) =>
    Effect.map(withSql(PoolLimits.cached), (limits) => ({
      ...read,
      accounts: read.accounts.map((account): PoolAccount => ({
        ...account,
        usageLimits: limits.get(account.name) ?? null,
      })),
    }));

  const accounts: PoolEngine["Service"]["accounts"] = (actor) =>
    Effect.flatMap(access(actor, "member"), ({ row, role }) =>
      cachedOrRead(row).pipe(
        Effect.flatMap(withLimits),
        Effect.flatMap((read) =>
          Effect.map(routingFor(row, role), (routing) => ({ ...read, role, routing })),
        ),
      ),
    );

  const advice: PoolEngine["Service"]["advice"] = (actor) =>
    Effect.gen(function* () {
      const { role } = yield* access(actor, "member");
      // Account counts and plans are admin-only, checked again on each read.
      if (role !== "admin") return null;
      const read = yield* Effect.flatMap(cachedAccounts, withLimits);
      return yield* withSql(
        PoolUsageHistory.advice(
          PoolUsageHistory.accountsWithQuota(read.accounts).filter(takesTurns),
          yield* Clock.currentTimeMillis,
        ),
      );
    });

  // A turn start may make its first read; later refreshes are passive.
  const models: PoolEngine["Service"]["models"] = (actor) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "member", {
        gone: "This thread's pool no longer exists. Pick another pool for it.",
        denied: "You no longer have access to this thread's pool. Pick another pool for it.",
      });
      yield* firstModelsRead(row);
      const before = yield* cachedModels;
      if (yield* canRefreshModels(row)) {
        const now = yield* Clock.currentTimeMillis;
        if (modelRefreshDue(before, now)) yield* refreshModelsIfDue(row);
      }
      return yield* cachedModels;
    });

  const cachedModelsForActor: PoolEngine["Service"]["cachedModels"] = (actor) =>
    Effect.as(access(actor, "member"), undefined).pipe(Effect.andThen(cachedModels));

  const refreshModelsAtAlarm: PoolEngine["Service"]["refreshModelsAtAlarm"] = () =>
    Effect.gen(function* () {
      const row = yield* poolRow;
      if (row === null || !(yield* schedulesModels(row))) return;
      yield* refreshModelsIfDue(row, true);
    });

  const nextModelsRefreshAt: PoolEngine["Service"]["nextModelsRefreshAt"] = () =>
    Effect.gen(function* () {
      const row = yield* poolRow;
      if (row === null || !(yield* schedulesModels(row))) return null;
      const cached = yield* cachedModels;
      const now = yield* Clock.currentTimeMillis;
      const next =
        cached.attemptedAt > cached.checkedAt
          ? cached.attemptedAt + MODELS_REFRESH_RETRY_MS
          : cached.checkedAt > 0
            ? cached.checkedAt + MODELS_REFRESH_MS
            : cached.attemptedAt > 0
              ? cached.attemptedAt + MODELS_REFRESH_RETRY_MS
              : now;
      return Math.max(now, next);
    });

  const nextUsageSampleAt: PoolEngine["Service"]["nextUsageSampleAt"] = () =>
    Effect.gen(function* () {
      const row = yield* poolRow;
      if (row === null) return null;
      const { accounts } = yield* cachedAccounts;
      if (
        !accounts.some(
          (account) =>
            PoolLimits.READS_LIMITS.has(account.type) && !account.disabled && !account.signedOut,
        )
      )
        return null;
      return yield* withSql(PoolUsageHistory.nextSampleAt(yield* Clock.currentTimeMillis));
    });

  const samplingUsage = yield* Semaphore.make(1);
  const refreshUsageAtAlarm: PoolEngine["Service"]["refreshUsageAtAlarm"] = () =>
    Effect.gen(function* () {
      const next = yield* nextUsageSampleAt();
      const now = yield* Clock.currentTimeMillis;
      if (next === null || next > now) return;
      yield* withSql(PoolUsageHistory.sampledAt(now));
      const row = yield* poolRow;
      if (row === null) return;
      // Unlike foreground snapshots, the quarter-hourly sample may wake a sleeping pool.
      const endpoint = endpointOf(row, { models: true });
      yield* ensureManagedConfig(endpoint);
      const live = yield* Effect.gen(function* () {
        const live = yield* CliProxyApi.listAccounts(endpoint);
        const cached = yield* cachedAccounts;
        // Login/import must discover new accounts so their contributor is recorded on insertion.
        const known = new Set(cached.accounts.map((account) => account.name));
        const held = live.filter((account) => known.has(account.name));
        yield* sql.withTransaction(storeAccountRows(held, cached.accounts, now));
        return live;
      }).pipe(accountChanges.withPermits(1));
      yield* refreshLimits(endpoint, live, now, "probe");
    }).pipe(
      samplingUsage.withPermits(1),
      Effect.timeoutOrElse({
        duration: ACCOUNTS_REFRESH_TIMEOUT_MS,
        orElse: () => Effect.logWarning("pool usage sample timed out"),
      }),
      Effect.catchTags({
        PoolBackendError: (cause) => Effect.logWarning("pool usage sample failed", { cause }),
      }),
    );

  const startLogin: PoolEngine["Service"]["startLogin"] = (actor, provider, flow) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "admin");
      yield* refuseIfLinked(row);
      const endpoint = endpointOf(row);
      const known = yield* refreshAccounts(row);
      const login = yield* CliProxyApi.startLogin(endpoint, provider, flow);
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO logins (state, started_by, started_at, known)
        VALUES (${login.state}, ${actor.userId}, ${now},
          ${encodeKnown(known.map((account) => account.name))})
        ON CONFLICT (state) DO NOTHING`;
      return login;
    });

  const loginStatus: PoolEngine["Service"]["loginStatus"] = (actor, state) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "admin");
      const status = yield* CliProxyApi.loginStatus(endpointOf(row), state);
      if (status.status === "wait") return status;
      const [login] = yield* sql<{
        readonly started_by: string;
        readonly known: string;
      }>`SELECT started_by, known FROM logins WHERE state = ${state}`;
      yield* sql`DELETE FROM logins WHERE state = ${state}`;
      if (status.status === "ok" && login !== undefined) {
        const before = new Set(decodeKnown(login.known));
        const added = yield* refreshAccounts(
          row,
          (name) => (before.has(name) ? null : login.started_by),
          // A new account's windows show as soon as it's in.
          { probe: true },
        );
        const names = added.filter((account) => !before.has(account.name)).map((a) => a.name);
        yield* audit(actor, "add-account", names.join(", ") || null);
      }
      return status;
    });

  const completeLogin: PoolEngine["Service"]["completeLogin"] = (actor, callback) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "admin");
      yield* CliProxyApi.completeLogin(endpointOf(row), callback);
    });

  const cancelLogin: PoolEngine["Service"]["cancelLogin"] = (actor, state) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "admin");
      const cancelled = yield* CliProxyApi.cancelLogin(endpointOf(row), state);
      if (cancelled) yield* sql`DELETE FROM logins WHERE state = ${state}`;
      return cancelled;
    });

  const logoutAccount: PoolEngine["Service"]["logoutAccount"] = (actor, provider, name) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "admin");
      yield* refuseIfLinked(row);
      const [account] = yield* sql<AccountRow>`SELECT * FROM accounts WHERE name = ${name}`;
      if (account === undefined || account.type !== provider) {
        return yield* reject("That account does not belong to this provider in this pool.");
      }
      const endpoint = endpointOf(row);
      const live = yield* CliProxyApi.listAccounts(endpoint);
      const credential = live.find((entry) => entry.name === name);
      if (credential !== undefined && credential.type !== provider) {
        return yield* reject("That account does not belong to this provider in this pool.");
      }
      // CLIProxyAPI invalidates its runtime session when its credential is removed.
      // Keep the pool account and attribution, so logout is distinct from removing it.
      if (credential !== undefined) {
        // A lost DELETE reply must not let refresh discard the row needed for a retry.
        yield* sql`INSERT INTO logged_out_accounts (name, pending) VALUES (${name}, 1)
          ON CONFLICT (name) DO UPDATE SET pending = 1`;
        yield* CliProxyApi.removeAccount(endpoint, name);
      }
      const now = yield* Clock.currentTimeMillis;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO logged_out_accounts (name, pending) VALUES (${name}, 0)
            ON CONFLICT (name) DO UPDATE SET pending = 0`;
          yield* sql`UPDATE accounts SET signed_out = 1 WHERE name = ${name}`;
          yield* sql`UPDATE accounts_state SET checked_at = ${now}, error = NULL WHERE id = 1`;
          yield* audit(actor, "logout-account", name);
        }),
      );
    }).pipe(accountChanges.withPermits(1));

  const updateAccount: PoolEngine["Service"]["updateAccount"] = (actor, name, action) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "admin");
      yield* refuseIfLinked(row);
      const endpoint = endpointOf(row);
      const loggedOut = yield* sql`SELECT 1 FROM logged_out_accounts WHERE name = ${name}
        AND pending = 0`;
      if (loggedOut.length > 0) {
        if (action !== "remove") return yield* reject("Sign in to this account again first.");
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM logged_out_accounts WHERE name = ${name}`;
            yield* sql`DELETE FROM accounts WHERE name = ${name}`;
          }),
        );
      } else if (action === "remove") {
        yield* CliProxyApi.removeAccount(endpoint, name);
        yield* sql`DELETE FROM logged_out_accounts WHERE name = ${name}`;
      } else yield* CliProxyApi.setAccountDisabled(endpoint, name, action === "pause");
      yield* audit(actor, `${action}-account`, name);
      yield* refreshAccounts(row).pipe(Effect.ignore);
    });

  const openLink: PoolEngine["Service"]["openLink"] = (actor, preview) =>
    Effect.gen(function* () {
      yield* access(actor, "admin");
      const secret = yield* links.open(actor.userId, preview);
      yield* audit(
        actor,
        preview === undefined ? "open-link" : "open-preview-link",
        preview?.origin,
      );
      return secret;
    });

  const linkInfo: PoolEngine["Service"]["linkInfo"] = (actor) =>
    Effect.gen(function* () {
      const { row, role } = yield* access(actor, "member");
      const { accounts: held } = yield* Effect.flatMap(cachedOrRead(row), withLimits);
      return {
        name: row.name,
        accounts: held.map(({ name, type, email, disabled, signedOut, usageLimits }) => ({
          name,
          type,
          ...(role === "admin" && email !== null ? { email } : {}),
          disabled,
          signedOut,
          ...(role === "admin" && usageLimits !== null ? { usageLimits } : {}),
        })),
      };
    });

  const importAccounts: PoolEngine["Service"]["importAccounts"] = (actor, files) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "admin");
      yield* refuseIfLinked(row);
      // One entry per name: the last one sent wins.
      const credentials = new Map<string, Record<string, unknown>>();
      for (const file of files) {
        const credential = decodeCredential(file.content);
        if (!ACCOUNT_FILE_NAME.test(file.name) || credential._tag === "None") {
          return yield* reject(`${file.name} is not an account file.`);
        }
        if (!isCloudPoolAccountType(credential.value.type)) {
          return yield* reject(`${file.name} is an account Signalbox Cloud pools can't hold yet.`);
        }
        credentials.set(file.name, credential.value);
      }
      const endpoint = endpointOf(row);
      const held = new Set((yield* refreshAccounts(row)).map((account) => account.name));
      const skipped = [...credentials.keys()].filter((name) => held.has(name));
      const toSave = [...credentials].filter(([name]) => !held.has(name));
      const imported: string[] = [];
      yield* Effect.forEach(
        toSave,
        ([name, credential]) =>
          CliProxyApi.uploadAccount(endpoint, name, credential).pipe(
            Effect.tap(() => Effect.sync(() => imported.push(name))),
          ),
        { concurrency: MOVE_CONCURRENCY, discard: true },
      ).pipe(
        // All or nothing: what this call saved goes again.
        Effect.onError(() =>
          Effect.forEach(
            imported,
            (name) => CliProxyApi.removeAccount(endpoint, name).pipe(Effect.ignore),
            { concurrency: MOVE_CONCURRENCY, discard: true },
          ).pipe(Effect.andThen(refreshAccounts(row).pipe(Effect.ignore))),
        ),
      );
      const added = new Set(imported);
      yield* refreshAccounts(row, (name) => (added.has(name) ? actor.userId : null)).pipe(
        Effect.ignore,
      );
      yield* audit(actor, "move-in", imported.join(", ") || null);
      return { imported, skipped };
    });

  const forwardModel: PoolEngine["Service"]["forwardModel"] = (
    actor,
    path,
    request,
    thread,
    trace,
  ) =>
    Effect.gen(function* () {
      // Said in the turn that fails, which is how someone removed from the pool finds out.
      const { row } = yield* access(actor, "member", {
        gone: "This thread's pool no longer exists. Pick another pool for it.",
        denied: "You no longer have access to this thread's pool. Pick another pool for it.",
      });
      const clock = yield* Clock.Clock;
      const sent = { at: clock.currentTimeMillisUnsafe() };
      // Accounts that serve models: a pool without any has nothing to wait for on a cold start.
      const serving =
        yield* sql`SELECT 1 FROM accounts WHERE disabled = 0 AND signed_out = 0 LIMIT 1`;
      const endpoint = endpointOf(row, {
        actor,
        ...(thread === undefined ? {} : { thread }),
        ...(trace === undefined ? {} : { trace }),
        onSend: () => {
          sent.at = clock.currentTimeMillisUnsafe();
        },
        ...(serving.length > 0 ? { models: true } : {}),
      });
      yield* ensureManagedConfig(endpoint);
      // An admin's own CLIProxyAPI keeps its accounts as its config says.
      const managed = endpoint.baseUrl === PoolContainer.CONTAINER_ORIGIN;
      const { response, accountMoved, limited } =
        thread !== undefined && endpoint.link
          ? yield* ThreadAccounts.forwardViaLink(endpoint, path, request, thread)
          : thread !== undefined && managed
            ? yield* threadAccounts.forward(endpoint, path, request, thread, yield* routingOf)
            : {
                response: yield* CliProxyApi.forwardModel(endpoint, path, request),
                accountMoved: null,
                limited: false,
              };
      const upstreamMs = clock.currentTimeMillisUnsafe() - sent.at;
      if (response.status === 429 || limited) yield* checkHeldAccounts(row);
      return { response, upstreamMs, accountMoved };
    });

  const storeRequest: PoolEngine["Service"]["storeRequest"] = (request) =>
    Effect.gen(function* () {
      const row = yield* poolRow;
      if (row === null) return new Response(null, { status: 404 });
      return yield* PoolStore.handleStoreRequest(request, row.store_access_key);
    }).pipe(Effect.provideService(PoolStore.PoolStore, store));

  return PoolEngine.of({
    initialize: Effect.asVoid(migrate.pipe(Effect.provideService(SqlClient.SqlClient, sql))),
    create,
    info,
    rename,
    setRouting,
    setBacking,
    prepareDelete,
    accounts,
    advice,
    models,
    cachedModels: cachedModelsForActor,
    refreshModelsAtAlarm,
    nextModelsRefreshAt,
    refreshUsageAtAlarm,
    nextUsageSampleAt,
    startLogin,
    loginStatus,
    completeLogin,
    cancelLogin,
    logoutAccount,
    updateAccount,
    openLink,
    linkInfo,
    importAccounts,
    forwardModel,
    storeRequest,
  });
});

export const layer = Layer.effect(PoolEngine, make);
