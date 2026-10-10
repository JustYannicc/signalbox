import type { UsageLimitSourceUpdateAccountInput } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as CliProxyApi from "./cliProxyApi.ts";
import * as PoolContainer from "./PoolContainer.ts";
import * as PoolStore from "./poolStore.ts";

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
}

export interface PoolAccount extends CliProxyApi.BackendAccount {
  /** The user who signed it in, when it came in through this pool. */
  readonly contributedBy: string | null;
}

export interface PoolAccounts {
  readonly checkedAt: number;
  readonly accounts: ReadonlyArray<PoolAccount>;
  /** Why the latest read failed; `accounts` is then the last known list. */
  readonly error: string | null;
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
    readonly startLogin: (
      actor: PoolActor,
      provider: CliProxyApi.PoolLoginProvider,
    ) => Effect.Effect<CliProxyApi.LoginStart, Failure>;
    readonly loginStatus: (
      actor: PoolActor,
      state: string,
    ) => Effect.Effect<CliProxyApi.LoginStatus, Failure>;
    readonly completeLogin: (actor: PoolActor, redirectUrl: string) => Effect.Effect<void, Failure>;
    readonly cancelLogin: (actor: PoolActor, state: string) => Effect.Effect<void, Failure>;
    readonly updateAccount: (
      actor: PoolActor,
      name: string,
      action: AccountAction,
    ) => Effect.Effect<void, Failure>;
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
});

const migrate = Migrator.make({})({ loader: migrations });

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

/** How old the account list may get before a read asks the CLIProxyAPI again. */
const ACCOUNTS_FRESH_MS = 30_000;

/** The account names a sign-in started with. */
const KnownAccounts = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeKnown = Schema.encodeSync(KnownAccounts);
const decodeKnown = Schema.decodeUnknownSync(KnownAccounts);

const reject = (reason: string) => Effect.fail(new PoolRejectedError({ reason }));

const backingOf = (row: PoolRow): PoolBacking =>
  row.backing === "external" && row.external_url !== null
    ? { mode: "external", url: row.external_url }
    : { mode: "managed" };

const normalizeUrl = (url: string) => url.trim().replace(/\/+$/u, "");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* PoolStore.PoolStore;
  const container = yield* PoolContainer.PoolContainer;
  const external = yield* ExternalFetch;
  const crypto = yield* Crypto.Crypto;
  const randomKey = crypto.randomBytes(32).pipe(Effect.map(Hex.encode), Effect.orDie);

  const poolRow = sql<PoolRow>`SELECT name, personal, backing, management_key, client_key,
    store_access_key, store_secret_key, external_url, external_management_key,
    external_client_key FROM pool WHERE id = 1`.pipe(Effect.map(([row]) => row ?? null));

  const audit = (actor: PoolActor, action: string, detail: string | null = null) =>
    Effect.gen(function* () {
      const at = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO audit (at, actor, action, detail)
        VALUES (${at}, ${actor.userId}, ${action}, ${detail})`;
    });

  /** The pool row and the actor's role, when they hold at least `needed`. */
  const access = (actor: PoolActor, needed: PoolRole) =>
    Effect.gen(function* () {
      const row = yield* poolRow;
      if (row === null) return yield* reject("This pool no longer exists.");
      const [grant] = yield* sql<{
        readonly role: PoolRole;
      }>`SELECT role FROM grants WHERE user_id = ${actor.userId}`;
      if (grant === undefined) return yield* reject("You don't have access to this pool.");
      if (needed === "admin" && grant.role !== "admin") {
        return yield* reject("Only the pool's admins can do that.");
      }
      return { row, role: grant.role };
    });

  const infoOf = (row: PoolRow, role: PoolRole): PoolInfo => ({
    name: row.name,
    personal: row.personal === 1,
    backing: backingOf(row),
    role,
  });

  /**
   * Where the pool's CLIProxyAPI answers. `passive` reads reach a managed
   * pool's container only while it is up anyway, and never keep it up.
   */
  const endpointOf = (
    row: PoolRow,
    options?: { readonly passive: true },
  ): CliProxyApi.PoolEndpoint =>
    row.backing === "external" &&
    row.external_url !== null &&
    row.external_management_key !== null &&
    row.external_client_key !== null
      ? {
          fetch: external.fetch,
          baseUrl: row.external_url,
          managementKey: row.external_management_key,
          clientKey: row.external_client_key,
        }
      : {
          fetch: (request) =>
            options?.passive
              ? container.peek(request)
              : container.fetch(request, {
                  accessKey: row.store_access_key,
                  secretKey: row.store_secret_key,
                }),
          baseUrl: PoolContainer.CONTAINER_ORIGIN,
          managementKey: row.management_key,
          clientKey: row.client_key,
        };

  const cachedAccounts = Effect.gen(function* () {
    const rows = yield* sql<AccountRow>`SELECT name, type, email, disabled, signed_out,
      contributed_by FROM accounts ORDER BY added_at, name`;
    const [state] = yield* sql<{
      readonly checked_at: number;
      readonly error: string | null;
    }>`SELECT checked_at, error FROM accounts_state WHERE id = 1`;
    return {
      checkedAt: state?.checked_at ?? 0,
      error: state?.error ?? null,
      accounts: rows.map((row): PoolAccount => ({
        name: row.name,
        type: row.type,
        email: row.email,
        disabled: row.disabled === 1,
        signedOut: row.signed_out === 1,
        contributedBy: row.contributed_by,
      })),
    };
  });

  /**
   * Reads the CLIProxyAPI's accounts into the cache, keeping who contributed
   * each, and writes only what changed. `contributors` names the contributor
   * of accounts new to the cache.
   */
  const refreshAccounts = (
    row: PoolRow,
    contributors: (name: string) => string | null = () => null,
    options?: { readonly passive: true },
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const live = yield* CliProxyApi.listAccounts(endpointOf(row, options)).pipe(
        Effect.catchTags({
          PoolBackendError: (error) =>
            sql`UPDATE accounts_state SET checked_at = ${now}, error = ${error.detail}
              WHERE id = 1`.pipe(Effect.andThen(Effect.fail(error))),
        }),
      );
      const cached = yield* cachedAccounts;
      const known = new Map(cached.accounts.map((account) => [account.name, account]));
      const changed = live.filter((account) => {
        const before = known.get(account.name);
        return (
          before === undefined ||
          before.type !== account.type ||
          before.email !== account.email ||
          before.disabled !== account.disabled ||
          before.signedOut !== account.signedOut
        );
      });
      const names = new Set(live.map((account) => account.name));
      const removed = cached.accounts.filter((account) => !names.has(account.name));
      if (changed.length === 0 && removed.length === 0 && cached.error === null) return live;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          for (const account of changed) {
            const contributor = known.has(account.name) ? null : contributors(account.name);
            yield* sql`INSERT INTO accounts (name, type, email, disabled, signed_out,
                contributed_by, added_at)
              VALUES (${account.name}, ${account.type}, ${account.email},
                ${account.disabled ? 1 : 0}, ${account.signedOut ? 1 : 0}, ${contributor}, ${now})
              ON CONFLICT (name) DO UPDATE SET type = excluded.type, email = excluded.email,
                disabled = excluded.disabled, signed_out = excluded.signed_out`;
          }
          for (const account of removed) {
            yield* sql`DELETE FROM accounts WHERE name = ${account.name}`;
          }
          yield* sql`UPDATE accounts_state SET checked_at = ${now}, error = NULL WHERE id = 1`;
        }),
      );
      return live;
    });

  const create: PoolEngine["Service"]["create"] = (actor, input) =>
    Effect.gen(function* () {
      const existing = yield* poolRow;
      if (existing !== null) {
        const { row, role } = yield* access(actor, "admin");
        return infoOf(row, role);
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
          yield* audit(actor, "create", input.name);
        }),
      );
      const { row, role } = yield* access(actor, "admin");
      return infoOf(row, role);
    });

  const info: PoolEngine["Service"]["info"] = (actor) =>
    Effect.map(access(actor, "member"), ({ row, role }) => infoOf(row, role));

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
      yield* audit(actor, "set-backing", backing.mode === "managed" ? "managed" : backing.url);
      const updated = yield* access(actor, "admin");
      // A managed pool's accounts come back when its container next wakes.
      if (updated.row.backing === "external") {
        yield* refreshAccounts(updated.row).pipe(Effect.ignore);
      }
      return infoOf(updated.row, updated.role);
    });

  const prepareDelete: PoolEngine["Service"]["prepareDelete"] = (actor) =>
    Effect.gen(function* () {
      if ((yield* poolRow) === null) return;
      const { row } = yield* access(actor, "admin");
      if (row.personal === 1) return yield* reject("Your personal pool can't be deleted.");
      yield* container.stop;
    });

  const accounts: PoolEngine["Service"]["accounts"] = (actor) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "member");
      const cached = yield* cachedAccounts;
      if ((yield* Clock.currentTimeMillis) - cached.checkedAt < ACCOUNTS_FRESH_MS) return cached;
      // Reading never wakes a sleeping container or keeps one awake: an asleep
      // pool's accounts are what it last had.
      if (row.backing !== "external" && !(yield* container.running)) return cached;
      const read = yield* refreshAccounts(row, undefined, { passive: true }).pipe(Effect.result);
      return read._tag === "Success" ? yield* cachedAccounts : cached;
    });

  const startLogin: PoolEngine["Service"]["startLogin"] = (actor, provider) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "admin");
      const endpoint = endpointOf(row);
      const known = yield* refreshAccounts(row);
      const login = yield* CliProxyApi.startLogin(endpoint, provider);
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
        const added = yield* refreshAccounts(row, (name) =>
          before.has(name) ? null : login.started_by,
        );
        const names = added.filter((account) => !before.has(account.name)).map((a) => a.name);
        yield* audit(actor, "add-account", names.join(", ") || null);
      }
      return status;
    });

  const completeLogin: PoolEngine["Service"]["completeLogin"] = (actor, redirectUrl) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "admin");
      yield* CliProxyApi.completeLogin(endpointOf(row), redirectUrl);
    });

  const cancelLogin: PoolEngine["Service"]["cancelLogin"] = (actor, state) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "admin");
      yield* sql`DELETE FROM logins WHERE state = ${state}`;
      yield* CliProxyApi.cancelLogin(endpointOf(row), state);
    });

  const updateAccount: PoolEngine["Service"]["updateAccount"] = (actor, name, action) =>
    Effect.gen(function* () {
      const { row } = yield* access(actor, "admin");
      const endpoint = endpointOf(row);
      if (action === "remove") yield* CliProxyApi.removeAccount(endpoint, name);
      else yield* CliProxyApi.setAccountDisabled(endpoint, name, action === "pause");
      yield* audit(actor, `${action}-account`, name);
      yield* refreshAccounts(row).pipe(Effect.ignore);
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
    setBacking,
    prepareDelete,
    accounts,
    startLogin,
    loginStatus,
    completeLogin,
    cancelLogin,
    updateAccount,
    storeRequest,
  });
});

export const layer = Layer.effect(PoolEngine, make);
