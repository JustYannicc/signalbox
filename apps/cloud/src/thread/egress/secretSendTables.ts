import type { FolderId, OnePasswordEnvironmentId } from "@t3tools/contracts/signalboxFolders";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A thread's records for its egress check (#592, `ThreadSends.ts`):
 *
 * - `secret_sources`: the 1Password Environment each of its secrets came from
 *   on its current machine, as the machine registered them. The person's
 *   "Always" answers are kept against it.
 * - `secret_send_asks`: each time it asked its person to let secrets go to a
 *   host. Whether and how they answered is the request's, in the thread's own
 *   events; `kept_at` is when an "Always" answer reached their object.
 */

/** `ThreadStore`'s `0011_secret_sends` migration. */
export const migrateSecretSends = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE secret_sources (
    name TEXT PRIMARY KEY,
    environment TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE secret_send_asks (
    request_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    host TEXT NOT NULL,
    names TEXT NOT NULL,
    kept_at INTEGER
  )`;
  yield* sql`CREATE INDEX secret_send_asks_host ON secret_send_asks (host)`;
});

/** Adds the home that authorized an Always answer; old pending approvals have no safe scope. */
export const migrateSecretSendFolderScope = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE secret_send_asks ADD COLUMN folder_id TEXT`;
  // Old asks had no home to bind an Always answer to.
  yield* sql`ALTER TABLE secret_send_asks ADD COLUMN folder_scope_valid INTEGER NOT NULL DEFAULT 0`;
});

/** Replaces where the thread's secrets come from. Run it in the registration's transaction. */
export const saveSecretSources = (
  sources: ReadonlyArray<{ readonly name: string; readonly environment: OnePasswordEnvironmentId }>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM secret_sources`;
    for (const { name, environment } of sources) {
      yield* sql`INSERT INTO secret_sources (name, environment) VALUES (${name}, ${environment})`;
    }
  });

const decodeSources = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ name: Schema.String, environment: Schema.String })),
);

export const readSecretSources = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = decodeSources(yield* sql`SELECT name, environment FROM secret_sources`);
  return new Map(
    rows.map(({ name, environment }) => [name, environment as OnePasswordEnvironmentId]),
  ) as ReadonlyMap<string, OnePasswordEnvironmentId>;
});

export interface SecretAsk {
  readonly requestId: string;
  readonly runId: string;
  readonly folderId: FolderId | null;
  readonly folderScoped: boolean;
  readonly host: string;
  readonly names: ReadonlyArray<string>;
  readonly keptAt: number | null;
}

const encodeNames = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const decodeAsks = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      request_id: Schema.String,
      run_id: Schema.String,
      folder_id: Schema.NullOr(Schema.String),
      folder_scope_valid: Schema.Number,
      host: Schema.String,
      names: Schema.fromJsonString(Schema.Array(Schema.String)),
      kept_at: Schema.NullOr(Schema.Number),
    }),
  ),
);

/** The asks for `host`, or every one whose "Always" isn't kept in the owner's object yet. */
export const readSecretAsks = (which: { readonly host: string } | { readonly unkept: true }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      "host" in which
        ? yield* sql`SELECT request_id, run_id, folder_id, folder_scope_valid, host, names, kept_at
          FROM secret_send_asks WHERE host = ${which.host} ORDER BY rowid`
        : yield* sql`SELECT request_id, run_id, folder_id, folder_scope_valid, host, names, kept_at
          FROM secret_send_asks WHERE kept_at IS NULL ORDER BY rowid`;
    return decodeAsks(rows).map((row): SecretAsk => ({
      requestId: row.request_id,
      runId: row.run_id,
      folderId: row.folder_id as FolderId | null,
      folderScoped: row.folder_scope_valid === 1,
      host: row.host,
      names: row.names,
      keptAt: row.kept_at,
    }));
  });

/** How many asks the thread made: the next one's number. */
export const countSecretAsks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM secret_send_asks`;
  return row?.n ?? 0;
});

export type NewSecretAsk = Omit<SecretAsk, "keptAt" | "folderScoped">;

export const saveSecretAsk = (ask: NewSecretAsk) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO secret_send_asks
        (request_id, run_id, folder_id, folder_scope_valid, host, names)
      VALUES (${ask.requestId}, ${ask.runId}, ${ask.folderId}, 1, ${ask.host},
        ${encodeNames(ask.names)})`;
  });

export const markAskKept = (requestId: string, at: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE secret_send_asks SET kept_at = ${at} WHERE request_id = ${requestId}`;
  });
