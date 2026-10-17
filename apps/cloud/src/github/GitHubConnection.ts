import type { CommitAuthor } from "@signalbox/runner-protocol/DriveProtocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { GitHub } from "./GitHub.ts";
import { GitHubError } from "./GitHubApi.ts";
import { makeProfileId } from "../user/profileId.ts";

/**
 * A user's GitHub connection, in their own object. WorkOS Pipes holds the
 * OAuth tokens and refreshes them; this object only records that the user
 * connected (and as whom) and asks Pipes for a token whenever the cloud acts
 * as them: pushing, opening a pull request, or fetching for a machine
 * (`drive/remoteRoutes.ts`). Machines never get one.
 *
 * A Pipes authorize link is a bearer link: whoever opens it connects their
 * GitHub to the user who made it. So `begin` records a grant, and WorkOS
 * brings the browser back with it (signed, see `githubRoutes.ts`). Back in a
 * browser signed in as this user, `complete` uses the grant. Back anywhere
 * else, `abort` deletes what WorkOS stored, even when the grant was already
 * used: someone who sent the link out may have raced to complete it first.
 */

/** How long a connect attempt may take, and how long an abort can still undo it. */
export const GRANT_TTL_MS = 10 * 60_000;
/** Pipes is asked again at least this often, so a revoked connection stops working soon. */
const TOKEN_REUSE_MS = 5 * 60_000;
/** Tokens this close to expiring are fetched again. */
const EXPIRY_MARGIN_MS = 60_000;

export type ConnectStart =
  | { readonly _tag: "started"; readonly url: string }
  | { readonly _tag: "expired" }
  | { readonly _tag: "unavailable" };

export type ConnectResult =
  | { readonly _tag: "connected"; readonly login: string }
  | { readonly _tag: "failed"; readonly reason: string };

export interface GitHubAccount {
  readonly login: string;
  readonly githubUserId: number;
}

export class GitHubConnection extends Context.Service<
  GitHubConnection,
  {
    /** Whether this user's resolved WorkOS realm can connect GitHub. */
    readonly configured: Effect.Effect<boolean, SqlError>;
    /** The connected GitHub account, or null. */
    readonly account: Effect.Effect<{ readonly login: string } | null, SqlError>;
    /** Who the user's agents commit as: the connected account (`commitAuthorOf`), or null. */
    readonly commitAuthor: Effect.Effect<CommitAuthor | null, SqlError>;
    /** Starts connecting under `grantId`; WorkOS sends the browser back to `returnTo`. */
    readonly begin: (input: {
      readonly grantId: string;
      readonly returnTo: string;
    }) => Effect.Effect<ConnectStart, SqlError>;
    /** Finishes a connect `begin` started, back in this user's browser. */
    readonly complete: (grantId: string) => Effect.Effect<ConnectResult, SqlError>;
    /** Spends a cancelled attempt without forgetting an existing connection. */
    readonly cancel: (grantId: string) => Effect.Effect<boolean, SqlError>;
    /** Undoes a connect attempt that came back in someone else's browser. */
    readonly abort: (grantId: string) => Effect.Effect<void, SqlError>;
    /** The connection as recorded, for a preview of this user's to take along (`previewSetup/`). */
    readonly recorded: Effect.Effect<GitHubAccount | null, SqlError>;
    /** Records a connection Pipes already holds for this user, unless one is recorded here. */
    readonly adopt: (account: GitHubAccount) => Effect.Effect<void, SqlError>;
    /** Forgets the connection here and in WorkOS. */
    readonly disconnect: Effect.Effect<void, SqlError>;
    /**
     * A token to act as the user now. Null when not connected, or when GitHub
     * no longer honors the connection.
     */
    readonly accessToken: Effect.Effect<string | null, SqlError | GitHubError>;
  }
>()("@signalbox/cloud/github/GitHubConnection") {}

/** Part of `UserStore`'s `0006` migration. Kept as it ran; `0008` moved the connection to Pipes. */
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

/**
 * `UserStore`'s `0008` migration: tokens live in WorkOS Pipes now, so none are
 * kept here. No cloud ever had the GitHub App configured, so no connection is lost.
 */
export const moveToPipes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE github_connection`;
  yield* sql`CREATE TABLE github_connection (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    login TEXT NOT NULL,
    github_user_id INTEGER NOT NULL,
    connected_at INTEGER NOT NULL
  )`;
  yield* sql`DROP TABLE github_connect_grants`;
  yield* sql`CREATE TABLE github_connect_grants (
    grant_id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  )`;
});

/**
 * `UserStore`'s `0011` migration: the account's display name, which commits
 * are signed with. Connections made before it have none until they connect again.
 */
export const addName = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE github_connection ADD COLUMN name TEXT`;
});

/**
 * A GitHub account as a commit author: its display name, or its login without
 * one, at its noreply address. GitHub links commits by that address to the
 * account without showing the user's own email.
 */
export const commitAuthorOf = (account: {
  readonly login: string;
  readonly githubUserId: number;
  readonly name: string | null;
}): CommitAuthor => {
  // git refuses `<`, `>` and line breaks, and drops punctuation at either end; nothing left fails.
  const name = (account.name ?? "")
    .replace(/[<>\p{Cc}]/gu, "")
    .replace(/^[\s.,:;"'\\]+|[\s.,:;"'\\]+$/g, "");
  return {
    name: name === "" ? account.login : name,
    email: `${account.githubUserId}+${account.login}@users.noreply.github.com`,
  };
};

const ConnectionRow = Schema.Struct({
  login: Schema.String,
  github_user_id: Schema.Number,
  name: Schema.NullOr(Schema.String),
});
const decodeConnectionRows = Schema.decodeUnknownSync(Schema.Array(ConnectionRow));
const RecordedRow = Schema.Struct({ login: Schema.String, github_user_id: Schema.Number });
const decodeRecordedRows = Schema.decodeUnknownSync(Schema.Array(RecordedRow));

const pipesError = (error: { readonly status: number; readonly message: string }) =>
  new GitHubError({ operation: "token", status: error.status, message: error.message });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const github = yield* GitHub;
  const { api } = github;
  // The last token Pipes gave, so a burst of git requests doesn't ask WorkOS each time.
  const cached = yield* Ref.make<{ readonly token: string; readonly until: number } | null>(null);
  // One Pipes request at a time; the others wait for its token.
  const fetching = yield* Semaphore.make(1);

  const row = sql`SELECT login, github_user_id, name FROM github_connection WHERE id = 1`.pipe(
    Effect.map((rows) => decodeConnectionRows(rows)[0] ?? null),
  );
  const forget = Effect.andThen(
    Ref.set(cached, null),
    sql`DELETE FROM github_connection`.pipe(Effect.asVoid),
  );
  const userId = yield* makeProfileId;

  const configured: GitHubConnection["Service"]["configured"] = Effect.gen(function* () {
    const id = yield* userId;
    if (id === null) return false;
    return yield* github.pipesForUser(id).pipe(
      Effect.map((pipes) => pipes !== null),
      Effect.catch(() => Effect.succeed(false)),
    );
  });

  /** Forgets the connection in WorkOS too; a failure there only gets logged. */
  const forgetEverywhere = Effect.gen(function* () {
    yield* forget;
    const id = yield* userId;
    if (id === null) return;
    const pipes = yield* github.pipesForUser(id).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("resolving a GitHub identity for WorkOS disconnect failed", {
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (pipes === null) return;
    yield* pipes
      .disconnect(id)
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("deleting a GitHub connection in WorkOS failed", { cause }),
        ),
      );
  });

  const account: GitHubConnection["Service"]["account"] = Effect.map(row, (found) =>
    found === null ? null : { login: found.login },
  );

  const commitAuthor: GitHubConnection["Service"]["commitAuthor"] = Effect.map(row, (found) =>
    found === null
      ? null
      : commitAuthorOf({
          login: found.login,
          githubUserId: found.github_user_id,
          name: found.name,
        }),
  );

  const begin: GitHubConnection["Service"]["begin"] = (input) =>
    Effect.gen(function* () {
      const id = yield* userId;
      if (id === null) return { _tag: "unavailable" } as const;
      const pipes = yield* github
        .pipesForUser(id)
        .pipe(
          Effect.catch((cause) =>
            Effect.logError("resolving a GitHub identity in WorkOS failed", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
      if (pipes === null) return { _tag: "unavailable" } as const;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`DELETE FROM github_connect_grants WHERE expires_at <= ${now}`;
      const inserted = yield* sql<{
        readonly grant_id: string;
      }>`INSERT INTO github_connect_grants (grant_id, expires_at)
        VALUES (${input.grantId}, ${now + GRANT_TTL_MS})
        ON CONFLICT (grant_id) DO NOTHING RETURNING grant_id`;
      if (inserted.length === 0) return { _tag: "expired" } as const;
      const url = yield* pipes
        .authorizeUrl({ userId: id, returnTo: input.returnTo })
        .pipe(
          Effect.catch((cause) =>
            Effect.logError("starting a GitHub connection in WorkOS failed", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
      return url === null
        ? ({ _tag: "unavailable" } as const)
        : ({ _tag: "started", url } as const);
    });

  const complete: GitHubConnection["Service"]["complete"] = (grantId) =>
    Effect.gen(function* () {
      const failed = (reason: string): ConnectResult => ({ _tag: "failed", reason });
      const id = yield* userId;
      if (id === null) return failed("This cloud can't connect GitHub.");
      const pipes = yield* github
        .pipesForUser(id)
        .pipe(
          Effect.catch((cause) =>
            Effect.logError("resolving a GitHub identity in WorkOS failed", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        );
      if (pipes === null) return failed("This cloud can't connect GitHub.");
      const now = yield* Clock.currentTimeMillis;
      const open = yield* sql<{ readonly grant_id: string }>`SELECT grant_id
        FROM github_connect_grants WHERE grant_id = ${grantId} AND used = 0
          AND expires_at > ${now}`;
      if (open.length === 0) return failed("This GitHub sign-in expired. Start it again.");
      const token = yield* pipes.accessToken(id).pipe(Effect.result);
      if (token._tag === "Failure") return failed("WorkOS is unreachable right now. Try again.");
      if (token.success._tag === "inactive") return failed("GitHub didn't connect. Try again.");
      const viewer = yield* api.viewer(Redacted.value(token.success.token)).pipe(Effect.result);
      if (viewer._tag === "Failure" || viewer.success === null) {
        return failed("GitHub did not say who signed in.");
      }
      // Kept, not deleted, so a late `abort` can still undo it.
      const used = yield* sql<{ readonly grant_id: string }>`UPDATE github_connect_grants
        SET used = 1 WHERE grant_id = ${grantId} AND used = 0 RETURNING grant_id`;
      if (used.length === 0) return failed("This GitHub sign-in expired. Start it again.");
      yield* sql`INSERT INTO github_connection (id, login, github_user_id, name, connected_at)
        VALUES (1, ${viewer.success.login}, ${viewer.success.id}, ${viewer.success.name ?? null},
          ${now})
        ON CONFLICT (id) DO UPDATE SET login = excluded.login,
          github_user_id = excluded.github_user_id, name = excluded.name,
          connected_at = excluded.connected_at`;
      yield* Ref.set(cached, null);
      return { _tag: "connected", login: viewer.success.login } as const;
    });

  const cancel: GitHubConnection["Service"]["cancel"] = (grantId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const spent = yield* sql<{
        readonly grant_id: string;
      }>`UPDATE github_connect_grants SET used = 2
        WHERE grant_id = ${grantId} AND used = 0 AND expires_at > ${now} RETURNING grant_id`;
      return spent.length > 0;
    });

  const abort: GitHubConnection["Service"]["abort"] = (grantId) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      // Keep a tombstone until expiry so a native start URL cannot restart an aborted attempt.
      const spent = yield* sql<{
        readonly grant_id: string;
      }>`UPDATE github_connect_grants SET used = 3
        WHERE grant_id = ${grantId} AND used != 3 AND expires_at > ${now} RETURNING grant_id`;
      // Even a cancelled attempt may finish later in another browser and replace the user's Pipes account.
      if (spent.length > 0) yield* forgetEverywhere;
    });

  const disconnect: GitHubConnection["Service"]["disconnect"] = forgetEverywhere;

  const recorded: GitHubConnection["Service"]["recorded"] =
    sql`SELECT login, github_user_id FROM github_connection WHERE id = 1`.pipe(
      Effect.map((rows) => {
        const [found] = decodeRecordedRows(rows);
        return found ? { login: found.login, githubUserId: found.github_user_id } : null;
      }),
    );

  const adopt: GitHubConnection["Service"]["adopt"] = (input) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO github_connection (id, login, github_user_id, connected_at)
        VALUES (1, ${input.login}, ${input.githubUserId}, ${now})
        ON CONFLICT (id) DO NOTHING`;
    });

  const reuse = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(cached);
    return current !== null && current.until > now ? current.token : null;
  });

  const accessToken: GitHubConnection["Service"]["accessToken"] = Effect.gen(function* () {
    const id = yield* userId;
    if (id === null) return null;
    const pipes = yield* github.pipesForUser(id).pipe(Effect.mapError(pipesError));
    if (pipes === null) return null;
    const hit = yield* reuse;
    if (hit !== null) return hit;
    return yield* fetching.withPermits(1)(
      Effect.gen(function* () {
        // Another caller may have fetched one while this one waited.
        const fetched = yield* reuse;
        if (fetched !== null) return fetched;
        if ((yield* row) === null) return null;
        const answer = yield* pipes.accessToken(id).pipe(Effect.mapError(pipesError));
        if (answer._tag === "inactive") {
          // Revoked on GitHub or deleted in WorkOS: the user connects again.
          yield* Effect.logWarning("WorkOS has no usable GitHub connection; disconnecting", {
            reason: answer.reason,
          });
          yield* forget;
          return null;
        }
        const token = Redacted.value(answer.token);
        const now = yield* Clock.currentTimeMillis;
        const until = Math.min(
          now + TOKEN_REUSE_MS,
          answer.expiresAt === null
            ? Number.POSITIVE_INFINITY
            : answer.expiresAt - EXPIRY_MARGIN_MS,
        );
        yield* Ref.set(cached, { token, until });
        return token;
      }),
    );
  });

  return GitHubConnection.of({
    configured,
    account,
    commitAuthor,
    begin,
    complete,
    cancel,
    abort,
    disconnect,
    recorded,
    adopt,
    accessToken,
  });
});

export const layer = Layer.effect(GitHubConnection, make);
