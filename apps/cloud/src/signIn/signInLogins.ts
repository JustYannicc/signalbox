import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The sites the login service keeps a person's profile signed in to (#576):
 * one row per site, with its Kernel connection, whose credentials signed it
 * in and with which 1Password login. Never a value: a login is named by its
 * item id, title and username. A fork table, so it creates itself.
 *
 * `next_check_at` is when the re-login sweep next reads the connection;
 * `failure` is why the last unattended re-login stopped, which keeps the
 * sweep from trying again until an agent's sign-in succeeds.
 */

const ensureTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS signalbox_sign_in_logins (
    site TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    source TEXT NOT NULL,
    item_id TEXT NOT NULL,
    item_title TEXT NOT NULL,
    username TEXT,
    signed_in_at INTEGER NOT NULL,
    next_check_at INTEGER NOT NULL,
    failure TEXT
  )`;
});

const LoginRow = Schema.Struct({
  site: Schema.String,
  origin: Schema.String,
  connection_id: Schema.String,
  /** `person`, or `folder:<id>`, as grants key their source. */
  source: Schema.String,
  item_id: Schema.String,
  item_title: Schema.String,
  username: Schema.NullOr(Schema.String),
  next_check_at: Schema.Number,
  failure: Schema.NullOr(Schema.String),
});
export type LoginRow = typeof LoginRow.Type;
const decodeRows = Schema.decodeUnknownSync(Schema.Array(LoginRow));

export const makeSignInLogins = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.orDie(ensureTables);
  return {
    ofSite: (site: string) =>
      Effect.map(
        sql`SELECT site, origin, connection_id, source, item_id, item_title, username,
          next_check_at, failure FROM signalbox_sign_in_logins WHERE site = ${site}`,
        (rows) => decodeRows(rows)[0] ?? null,
      ),
    /** Rows the sweep reads now: due, and not stopped on a failure. */
    due: (now: number) =>
      Effect.map(
        sql`SELECT site, origin, connection_id, source, item_id, item_title, username,
          next_check_at, failure FROM signalbox_sign_in_logins
          WHERE next_check_at <= ${now} AND failure IS NULL ORDER BY next_check_at`,
        decodeRows,
      ),
    /** When the sweep has something to read next; null with nothing to keep signed in. */
    nextCheck: Effect.map(
      sql<{ readonly at: number | null }>`SELECT MIN(next_check_at) AS at
        FROM signalbox_sign_in_logins WHERE failure IS NULL`,
      (rows) => rows[0]?.at ?? null,
    ),
    /** A login that succeeded: the sweep keeps it signed in from now on. */
    signedIn: (row: Omit<LoginRow, "failure">, now: number) =>
      sql`INSERT INTO signalbox_sign_in_logins
          (site, origin, connection_id, source, item_id, item_title, username,
           signed_in_at, next_check_at, failure)
        VALUES (${row.site}, ${row.origin}, ${row.connection_id}, ${row.source}, ${row.item_id},
          ${row.item_title}, ${row.username}, ${now}, ${row.next_check_at}, NULL)
        ON CONFLICT (site) DO UPDATE SET origin = excluded.origin,
          connection_id = excluded.connection_id, source = excluded.source,
          item_id = excluded.item_id, item_title = excluded.item_title,
          username = excluded.username, signed_in_at = excluded.signed_in_at,
          next_check_at = excluded.next_check_at, failure = NULL`,
    checked: (site: string, nextCheckAt: number) =>
      sql`UPDATE signalbox_sign_in_logins SET next_check_at = ${nextCheckAt} WHERE site = ${site}`,
    failed: (site: string, failure: string) =>
      sql`UPDATE signalbox_sign_in_logins SET failure = ${failure} WHERE site = ${site}`,
    /** Kernel no longer has the connection: nothing to keep signed in. */
    forget: (site: string) => sql`DELETE FROM signalbox_sign_in_logins WHERE site = ${site}`,
    /** A person cleared the profile; the sweep must not restore its sign-ins. */
    clear: () => sql`DELETE FROM signalbox_sign_in_logins`,
  };
});
