import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { GitHub } from "./GitHub.ts";
import type { GitHubError, GitHubTokens } from "./GitHubApi.ts";

/**
 * A user's GitHub connection, in their own object (#135): the tokens from
 * Signalbox's GitHub App, which act as the user on the repositories the App is
 * installed on. This object is the only place they live. Machines never get
 * one; the cloud acts with them when it pushes, opens a pull request, or
 * fetches for a machine (`drive/remoteRoutes.ts`).
 *
 * Connecting is the App's web flow. `begin` records a one-time grant that the
 * callback must present, from a browser signed in as this user (see
 * `githubRoutes.ts`), so nobody can attach their GitHub to someone else.
 */

/** How long a connect attempt may take. */
const GRANT_TTL_MS = 10 * 60_000;
/** Tokens this close to expiring are refreshed first. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export type ConnectStart =
  | { readonly _tag: "started"; readonly grantId: string; readonly url: string }
  | { readonly _tag: "unavailable" };

export type ConnectResult =
  | { readonly _tag: "connected"; readonly login: string }
  | { readonly _tag: "failed"; readonly reason: string };

export class GitHubConnection extends Context.Service<
  GitHubConnection,
  {
    /** Whether this cloud has a GitHub App at all. */
    readonly configured: boolean;
    /** The connected GitHub account, or null. */
    readonly account: Effect.Effect<{ readonly login: string } | null, SqlError>;
    readonly begin: (redirectUri: string) => Effect.Effect<ConnectStart, SqlError>;
    readonly complete: (input: {
      readonly grantId: string;
      readonly code: string;
      readonly redirectUri: string;
    }) => Effect.Effect<ConnectResult, SqlError>;
    /** Forgets the tokens and revokes the user's authorization of the App. */
    readonly disconnect: Effect.Effect<void, SqlError>;
    /**
     * A token to act as the user now, refreshed when it is about to expire.
     * Null when not connected, or when GitHub no longer honors the connection.
     */
    readonly accessToken: Effect.Effect<string | null, SqlError | GitHubError>;
  }
>()("@signalbox/cloud/github/GitHubConnection") {}

/** Part of `UserStore`'s `0006` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE github_connection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    login TEXT NOT NULL,
    github_user_id INTEGER NOT NULL,
    access_token TEXT NOT NULL,
    access_expires_at INTEGER,
    refresh_token TEXT,
    refresh_expires_at INTEGER,
    connected_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE github_connect_grants (
    grant_id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`;
  // The repositories this user imported as drives (`GitHubImport.ts`), one each.
  yield* sql`CREATE TABLE github_drives (
    drive_id TEXT PRIMARY KEY,
    repository TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  )`;
});

const ConnectionRow = Schema.Struct({
  login: Schema.String,
  access_token: Schema.String,
  access_expires_at: Schema.NullOr(Schema.Number),
  refresh_token: Schema.NullOr(Schema.String),
  refresh_expires_at: Schema.NullOr(Schema.Number),
});
const decodeConnectionRows = Schema.decodeUnknownSync(Schema.Array(ConnectionRow));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const { app, api } = yield* GitHub;
  // One refresh at a time: GitHub rotates the refresh token on every use.
  const refreshing = yield* Semaphore.make(1);

  const row = sql`SELECT login, access_token, access_expires_at, refresh_token,
      refresh_expires_at FROM github_connection WHERE id = 1`.pipe(
    Effect.map((rows) => decodeConnectionRows(rows)[0] ?? null),
  );

  const storeTokens = (tokens: GitHubTokens) =>
    sql`UPDATE github_connection SET access_token = ${tokens.accessToken},
      access_expires_at = ${tokens.accessExpiresAt}, refresh_token = ${tokens.refreshToken},
      refresh_expires_at = ${tokens.refreshExpiresAt} WHERE id = 1`.pipe(Effect.asVoid);

  const forget = sql`DELETE FROM github_connection`.pipe(Effect.asVoid);

  const account: GitHubConnection["Service"]["account"] = Effect.map(row, (found) =>
    found === null ? null : { login: found.login },
  );

  const begin: GitHubConnection["Service"]["begin"] = (redirectUri) =>
    Effect.gen(function* () {
      if (app === null) return { _tag: "unavailable" } as const;
      const grantId = (yield* Effect.orDie(crypto.randomUUIDv4)).replaceAll("-", "");
      const now = yield* Clock.currentTimeMillis;
      yield* sql`DELETE FROM github_connect_grants WHERE expires_at <= ${now}`;
      yield* sql`INSERT INTO github_connect_grants (grant_id, expires_at)
        VALUES (${grantId}, ${now + GRANT_TTL_MS})`;
      return {
        _tag: "started",
        grantId,
        url: api.authorizeUrl(app, { redirectUri, state: grantId }),
      } as const;
    });

  const complete: GitHubConnection["Service"]["complete"] = (input) =>
    Effect.gen(function* () {
      const failed = (reason: string): ConnectResult => ({ _tag: "failed", reason });
      if (app === null) return failed("This cloud has no GitHub App.");
      const now = yield* Clock.currentTimeMillis;
      // Spent whatever happens next: a grant works once.
      const spent = yield* sql<{ readonly grant_id: string }>`DELETE FROM github_connect_grants
        WHERE grant_id = ${input.grantId} AND expires_at > ${now} RETURNING grant_id`;
      if (spent.length === 0) return failed("This GitHub sign-in expired. Start it again.");
      const exchanged = yield* api
        .exchangeCode(app, { code: input.code, redirectUri: input.redirectUri })
        .pipe(Effect.result);
      if (exchanged._tag === "Failure") return failed(exchanged.failure.message);
      const tokens = exchanged.success;
      const viewer = yield* api.viewer(tokens.accessToken).pipe(Effect.result);
      if (viewer._tag === "Failure" || viewer.success === null) {
        return failed("GitHub did not say who signed in.");
      }
      yield* sql`INSERT INTO github_connection (id, login, github_user_id, access_token,
          access_expires_at, refresh_token, refresh_expires_at, connected_at)
        VALUES (1, ${viewer.success.login}, ${viewer.success.id}, ${tokens.accessToken},
          ${tokens.accessExpiresAt}, ${tokens.refreshToken}, ${tokens.refreshExpiresAt}, ${now})
        ON CONFLICT (id) DO UPDATE SET login = excluded.login,
          github_user_id = excluded.github_user_id, access_token = excluded.access_token,
          access_expires_at = excluded.access_expires_at, refresh_token = excluded.refresh_token,
          refresh_expires_at = excluded.refresh_expires_at, connected_at = excluded.connected_at`;
      return { _tag: "connected", login: viewer.success.login } as const;
    });

  const disconnect: GitHubConnection["Service"]["disconnect"] = Effect.gen(function* () {
    const found = yield* row;
    yield* forget;
    if (app !== null && found !== null) {
      yield* api
        .revoke(app, found.access_token)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("revoking a GitHub connection failed", { cause }),
          ),
        );
    }
  });

  const accessToken: GitHubConnection["Service"]["accessToken"] = Effect.gen(function* () {
    const fresh = (found: typeof ConnectionRow.Type, now: number) =>
      found.access_expires_at === null || found.access_expires_at - now > REFRESH_MARGIN_MS;
    const current = yield* row;
    const now = yield* Clock.currentTimeMillis;
    if (current === null || fresh(current, now)) return current?.access_token ?? null;
    return yield* refreshing.withPermits(1)(
      Effect.gen(function* () {
        // Another caller may have refreshed while this one waited.
        const found = yield* row;
        if (found === null || fresh(found, now)) return found?.access_token ?? null;
        const refreshToken = found.refresh_token;
        if (
          app === null ||
          refreshToken === null ||
          (found.refresh_expires_at !== null && found.refresh_expires_at <= now)
        ) {
          yield* forget;
          return null;
        }
        const refreshed = yield* api.refresh(app, refreshToken).pipe(Effect.result);
        if (refreshed._tag === "Failure") {
          // GitHub said no (an OAuth error, or 400/401): the App was revoked or the token spent.
          // Anything else, an outage or a rate limit, keeps the connection for the next try.
          if ([200, 400, 401].includes(refreshed.failure.status)) {
            yield* Effect.logWarning("GitHub refused a token refresh; disconnecting", {
              message: refreshed.failure.message,
            });
            yield* forget;
            return null;
          }
          return yield* refreshed.failure;
        }
        yield* storeTokens(refreshed.success);
        return refreshed.success.accessToken;
      }),
    );
  });

  return GitHubConnection.of({
    configured: app !== null,
    account,
    begin,
    complete,
    disconnect,
    accessToken,
  });
});

export const layer = Layer.effect(GitHubConnection, make);
