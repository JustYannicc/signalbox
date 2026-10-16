import type { PoolRouting } from "@t3tools/contracts/accountHub";
import { discardResponseBody } from "@t3tools/shared/mcpResponsePayloads";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as CliProxyApi from "./cliProxyApi.ts";

/**
 * Which account each thread's turns run on. CLIProxyAPI keeps a session on
 * one account itself (`routing.session-affinity`), but only in memory and for
 * an hour, and a pool's container sleeps two minutes after its last request.
 * So most turns would start on whatever account its round robin picks next,
 * and lose the provider's prompt cache (and a Codex session) with it.
 *
 * The pool keeps the binding instead. A thread's first request goes where
 * CLIProxyAPI sends it, which names the account it picked (`servedBy`); the
 * thread's later requests are pinned to that account (`pinnedModel`). When it
 * can't serve them (out of quota, signed out, paused, gone), the thread moves
 * to the account CLIProxyAPI picks next and says so (`movedMessage`). Admins
 * who turn session affinity off get no pins, and `moveOn` is theirs too.
 */

/** `PoolEngine`'s `0008` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Per API: a thread's Claude and Codex turns run on different accounts.
  yield* sql`CREATE TABLE thread_accounts (
    thread TEXT NOT NULL,
    api TEXT NOT NULL,
    account TEXT NOT NULL,
    bound_at INTEGER NOT NULL,
    PRIMARY KEY (thread, api)
  )`;
  yield* sql`CREATE INDEX thread_accounts_bound_at ON thread_accounts (bound_at)`;
});

/**
 * How long a binding lasts. Long after any provider cache; a thread still
 * running then lands wherever CLIProxyAPI sends it once, and binds again.
 */
const BINDING_MS = 30 * 86_400_000;

/** How often expired bindings are dropped, and the account indexes read again on a miss. */
const PRUNE_MS = 3_600_000;
const INDEX_FRESH_MS = 30_000;

type ModelApi = "anthropic" | "openai";

/** The API a request speaks when it runs a model turn; nothing else is pinned. */
const apiOf = (method: string, path: string): ModelApi | null => {
  if (method !== "POST") return null;
  const [pathname] = path.split("?");
  return pathname === "/v1/messages" ? "anthropic" : pathname === "/v1/responses" ? "openai" : null;
};

/** Why a thread left its account: what the thread says, and what the audit log does. */
const MOVES = {
  limit: { because: "hit its usage limit", audit: "usage limit" },
  "signed-out": { because: "was signed out", audit: "signed out" },
  paused: { because: "was paused", audit: "paused" },
  gone: { because: "left the pool", audit: "left the pool" },
  unavailable: { because: "couldn't serve it", audit: "unavailable" },
  failing: { because: "kept failing", audit: "failing" },
} as const;
type MoveReason = keyof typeof MOVES;

/** What the thread says when it moved. Names no account: members don't see them. */
const movedMessage = (reason: MoveReason) =>
  `This thread's account ${MOVES[reason].because}, so the thread moved to another account in the pool. Its next reply starts without the provider's cache.`;

/**
 * What a pinned request's answer means for the binding, as CLIProxyAPI
 * itself decides when to rebind a session: `repin` when CLIProxyAPI no
 * longer knows the pin (the account's file was written again), a reason to
 * move, or null to keep the account and hand the answer back. Under `quota`,
 * transient failures keep it; the harness retries them.
 */
const verdict = (
  response: Response,
  moveOn: PoolRouting["moveOn"],
): Effect.Effect<MoveReason | "repin" | null> => {
  const { status } = response;
  if (status === 400) {
    return Effect.promise(() => response.clone().text()).pipe(
      Effect.map((text) => (text.includes("unknown provider for model") ? "repin" : null)),
    );
  }
  if (status === 401 || status === 403) return Effect.succeed("signed-out");
  if (status === 402 || status === 429) return Effect.succeed("limit");
  // CLIProxyAPI has no account left for the pin: it can't serve the model, or is unavailable.
  if (status === 404 || status === 503) return Effect.succeed("unavailable");
  if ((status === 408 || status >= 500) && moveOn === "any") return Effect.succeed("failing");
  return Effect.succeed(null);
};

const ModelBody = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ model: Schema.String }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
);
const decodeModelBody = Schema.decodeUnknownOption(ModelBody);
const encodeModelBody = Schema.encodeSync(ModelBody);

/** `body` asking for its model on the account with `authIndex`, or null when it names no model. */
const pinned = (body: string, authIndex: string) =>
  Option.getOrNull(
    Option.map(decodeModelBody(body), (decoded) =>
      encodeModelBody({ ...decoded, model: CliProxyApi.pinnedModel(authIndex, decoded.model) }),
    ),
  );

/**
 * A forwarded model response, what the thread should say if it moved, and
 * whether an account hit its limit on the way (the pool then checks its
 * held accounts, `poolLimits.ts`).
 */
export interface ThreadReply {
  readonly response: Response;
  readonly accountMoved: string | null;
  readonly limited: boolean;
}

const unmoved = (response: Response): ThreadReply => ({
  response,
  accountMoved: null,
  limited: false,
});

/** What came of sending a thread's request to its own account. */
type Attempt =
  | { readonly _tag: "served"; readonly response: Response }
  | { readonly _tag: "unpinnable" }
  | { readonly _tag: "move"; readonly reason: MoveReason };

/** Binds threads in one pool's object, which keeps its accounts in `accounts`. */
export const make = (deps: {
  readonly sql: SqlClient.SqlClient;
  readonly audit: (detail: string) => Effect.Effect<void, SqlError>;
}) => {
  const { sql } = deps;
  /** Names by `auth_index` and back, from the CLIProxyAPI's last account list. */
  const byIndex = new Map<string, string>();
  const indexOf = new Map<string, string>();
  const reads = { indexesAt: 0, prunedAt: 0 };
  /** Accounts given their pin since this object started; CLIProxyAPI keeps it in their file. */
  const pinnedNames = new Set<string>();

  /** Reads the account list again on a miss, at most every `INDEX_FRESH_MS`. */
  const refreshIndexes = (endpoint: CliProxyApi.PoolEndpoint) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now - reads.indexesAt < INDEX_FRESH_MS) return;
      reads.indexesAt = now;
      const live = yield* CliProxyApi.listAccounts(endpoint);
      byIndex.clear();
      indexOf.clear();
      for (const account of live) {
        if (account.usage._tag !== "observed" || account.usage.authIndex === null) continue;
        byIndex.set(account.usage.authIndex, account.name);
        indexOf.set(account.name, account.usage.authIndex);
      }
    });

  const lookup = (endpoint: CliProxyApi.PoolEndpoint, map: Map<string, string>, key: string) =>
    Effect.gen(function* () {
      if (!map.has(key)) yield* refreshIndexes(endpoint);
      return map.get(key) ?? null;
    });

  const bound = (thread: string, api: ModelApi) =>
    sql<{ readonly account: string; readonly bound_at: number }>`SELECT account, bound_at
      FROM thread_accounts WHERE thread = ${thread} AND api = ${api}`.pipe(
      Effect.flatMap(([row]) =>
        Effect.map(Clock.currentTimeMillis, (now) =>
          row === undefined || now - row.bound_at > BINDING_MS ? null : row.account,
        ),
      ),
    );

  const bind = (thread: string, api: ModelApi, account: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now - reads.prunedAt > PRUNE_MS) {
        reads.prunedAt = now;
        yield* sql`DELETE FROM thread_accounts WHERE bound_at < ${now - BINDING_MS}`;
      }
      yield* sql`INSERT INTO thread_accounts (thread, api, account, bound_at)
        VALUES (${thread}, ${api}, ${account}, ${now})
        ON CONFLICT (thread, api) DO UPDATE SET account = excluded.account,
          bound_at = excluded.bound_at`;
    });

  /** Why the pool's cached account list says `name` can't serve, before asking the CLIProxyAPI. */
  const unusable = (name: string) =>
    sql<{ readonly disabled: number; readonly signed_out: number }>`SELECT disabled, signed_out
      FROM accounts WHERE name = ${name}`.pipe(
      Effect.map(([row]): MoveReason | null =>
        row === undefined ? "gone" : row.disabled ? "paused" : row.signed_out ? "signed-out" : null,
      ),
    );

  /** Sends `body` to the thread's own account, pinning it there first if this object hasn't. */
  const attempt = (
    endpoint: CliProxyApi.PoolEndpoint,
    path: string,
    request: Request,
    body: string,
    name: string,
    moveOn: PoolRouting["moveOn"],
  ) =>
    Effect.gen(function* () {
      const reason = yield* unusable(name);
      if (reason !== null) return { _tag: "move", reason } satisfies Attempt;
      const authIndex = yield* lookup(endpoint, indexOf, name);
      const pinnedBody = authIndex === null ? null : pinned(body, authIndex);
      if (authIndex === null || pinnedBody === null)
        return { _tag: "unpinnable" } satisfies Attempt;
      for (const _ of [1, 2]) {
        if (!pinnedNames.has(name)) {
          yield* CliProxyApi.setAccountPin(endpoint, name, authIndex);
          pinnedNames.add(name);
        }
        const response = yield* CliProxyApi.forwardModel(
          endpoint,
          path,
          withBody(request, pinnedBody),
        );
        const outcome = yield* verdict(response, moveOn);
        if (outcome === null) return { _tag: "served", response } satisfies Attempt;
        yield* discardResponseBody(response);
        if (outcome !== "repin") return { _tag: "move", reason: outcome } satisfies Attempt;
        pinnedNames.delete(name);
      }
      // Pinned twice and still unknown: CLIProxyAPI won't route to it.
      return { _tag: "move", reason: "unavailable" } satisfies Attempt;
    });

  /**
   * A thread's model request on a pool Signalbox runs. Requests that run no
   * model, and every request while the admins keep affinity off, pass as is.
   */
  const forward = (
    endpoint: CliProxyApi.PoolEndpoint,
    path: string,
    request: Request,
    thread: string,
    routing: PoolRouting,
  ) =>
    Effect.gen(function* () {
      const api = apiOf(request.method, path);
      const account = api === null || !routing.sessionAffinity ? null : yield* bound(thread, api);
      let reason: MoveReason | null = null;
      let unpinned = request;
      if (api !== null && account !== null) {
        // Held whole: a pinned request that can't be served goes again, unpinned.
        const body = yield* Effect.promise(() => request.text());
        const tried = yield* attempt(endpoint, path, request, body, account, routing.moveOn);
        if (tried._tag === "served") return unmoved(tried.response);
        // A thread that could not be pinned keeps its account for the next request.
        if (tried._tag === "unpinnable") {
          return unmoved(yield* CliProxyApi.forwardModel(endpoint, path, withBody(request, body)));
        }
        reason = tried.reason;
        unpinned = withBody(request, body);
      }
      const response = yield* CliProxyApi.forwardModel(endpoint, path, unpinned);
      const limited = reason === "limit";
      const servedIndex =
        api === null || !routing.sessionAffinity || !response.ok
          ? null
          : CliProxyApi.servedBy(response);
      const served = servedIndex === null ? null : yield* lookup(endpoint, byIndex, servedIndex);
      if (api === null || served === null) return { ...unmoved(response), limited };
      yield* bind(thread, api, served);
      if (account === null || reason === null || served === account) {
        return { ...unmoved(response), limited };
      }
      yield* deps.audit(`${thread}: ${account} → ${served} (${MOVES[reason].audit})`);
      yield* Effect.logInfo("pool thread moved account").pipe(
        Effect.annotateLogs({ "pool.thread.api": api, "pool.thread.move_reason": reason }),
      );
      return { response, accountMoved: movedMessage(reason), limited } satisfies ThreadReply;
    });

  return { forward };
};

/** `request` again with `body`, which the pin made longer than it said. */
const withBody = (request: Request, body: string) => {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: request.method, headers, body });
};

/**
 * How a thread's binding crosses a pool link: a preview's pool runs on
 * production's, which holds the accounts and so the bindings. The link
 * request names the thread, and the answer says whether it moved.
 */
const THREAD_HEADER = "x-signalbox-thread";
const MOVED_HEADER = "x-signalbox-account-moved";

/** A thread's model request on a pool backed by another cloud's pool link. */
export const forwardViaLink = (
  endpoint: CliProxyApi.PoolEndpoint,
  path: string,
  request: Request,
  thread: string,
) =>
  Effect.gen(function* () {
    const headers = new Headers(request.headers);
    headers.set(THREAD_HEADER, thread);
    const response = yield* CliProxyApi.forwardModel(
      endpoint,
      path,
      new Request(request, { headers }),
    );
    const moved = response.headers.get(MOVED_HEADER);
    if (moved === null) return unmoved(response);
    return {
      response: CliProxyApi.withHeaders(response, (unmarked) => unmarked.delete(MOVED_HEADER)),
      accountMoved: decodeURIComponent(moved),
      limited: false,
    } satisfies ThreadReply;
  });

/** The link's side: the thread a request names, and the request's headers without it. */
export const threadOfLinkRequest = (request: Request) => {
  const thread = request.headers.get(THREAD_HEADER);
  const headers = new Headers(request.headers);
  headers.delete(THREAD_HEADER);
  return { thread: thread === null || thread === "" ? undefined : thread, headers };
};

/** The link's answer, saying when the thread moved. */
export const markMoved = (reply: {
  readonly response: Response;
  readonly accountMoved: string | null;
}) => {
  const { accountMoved } = reply;
  if (accountMoved === null) return reply.response;
  return CliProxyApi.withHeaders(reply.response, (headers) =>
    headers.set(MOVED_HEADER, encodeURIComponent(accountMoved)),
  );
};
