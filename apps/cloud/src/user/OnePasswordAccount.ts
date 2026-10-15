import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * The user's 1Password service account (#395): one per user, whose token
 * reads the 1Password Environments their folders name when a thread starts.
 * Only the thread's machine ever gets the token (`ThreadRunner`'s
 * `ThreadSecrets`); clients see when it was connected, never the token.
 *
 * The token is stored as it is, like pools' OAuth credentials in their own
 * objects: Durable Object storage is encrypted at rest. Never log it.
 * Storage only: `UserFolders` makes every change and tells subscribers.
 */

export class OnePasswordAccount extends Context.Service<
  OnePasswordAccount,
  {
    /** When the current token was connected; null when none is. */
    readonly connectedAt: Effect.Effect<number | null, SqlError>;
    /** The current token, for the thread's machine only. */
    readonly token: Effect.Effect<string | null, SqlError>;
    /**
     * Connects `token`, replacing any before; null disconnects. True when
     * that changed anything. Callers run it in their transaction.
     */
    readonly set: (token: string | null) => Effect.Effect<boolean, SqlError>;
    /** Connects `token` only when none is connected: a preview taking production's. */
    readonly adopt: (token: string) => Effect.Effect<boolean, SqlError>;
  }
>()("@signalbox/cloud/user/OnePasswordAccount") {}

/** Part of `UserStore`'s `0014` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE onepassword_account (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    connected_at INTEGER NOT NULL
  )`;
});

const decodeRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ token: Schema.String, connected_at: Schema.Number })),
);

export const layer = Layer.effect(
  OnePasswordAccount,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const current = Effect.map(
      sql`SELECT token, connected_at FROM onepassword_account WHERE id = 1`,
      (rows) => decodeRows(rows)[0] ?? null,
    );

    const set: OnePasswordAccount["Service"]["set"] = (token) =>
      Effect.gen(function* () {
        const before = yield* current;
        if ((before?.token ?? null) === token) return false;
        if (token === null) {
          yield* sql`DELETE FROM onepassword_account WHERE id = 1`;
          return true;
        }
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO onepassword_account (id, token, connected_at)
          VALUES (1, ${token}, ${now})
          ON CONFLICT (id) DO UPDATE SET token = excluded.token,
            connected_at = excluded.connected_at`;
        return true;
      });

    const adopt: OnePasswordAccount["Service"]["adopt"] = (token) =>
      Effect.flatMap(current, (before) => (before === null ? set(token) : Effect.succeed(false)));

    return OnePasswordAccount.of({
      connectedAt: Effect.map(current, (row) => row?.connected_at ?? null),
      token: Effect.map(current, (row) => row?.token ?? null),
      set,
      adopt,
    });
  }),
);
