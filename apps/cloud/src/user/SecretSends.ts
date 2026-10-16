import type { OnePasswordEnvironmentId, SecretSend } from "@t3tools/contracts/signalboxFolders";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * The hosts the person always lets their agents send a folder secret to
 * (#592): the "Always" answers to a thread's first send of a secret to a new
 * host (`thread/egress/`). Kept per 1Password Environment and variable name,
 * so the same name in another Environment is another secret and asks again.
 * A revoked grant keeps its row, with when, so the record shows what agents
 * were allowed and until when.
 *
 * Storage only: `UserFolders` makes every change and tells subscribers.
 */

export interface SecretSendKey {
  readonly environmentId: OnePasswordEnvironmentId;
  readonly name: string;
  readonly host: string;
}

export class SecretSends extends Context.Service<
  SecretSends,
  {
    /** Every grant in force, by Environment, name and host. */
    readonly inForce: Effect.Effect<ReadonlyArray<SecretSend>, SqlError>;
    /** Which of `sends` the person always allows to `host`. */
    readonly allowed: (
      host: string,
      sends: ReadonlyArray<Omit<SecretSendKey, "host">>,
    ) => Effect.Effect<ReadonlySet<string>, SqlError>;
    /** Keeps each grant not in force yet. True when that changed anything. Callers run it in their transaction. */
    readonly keep: (
      grants: ReadonlyArray<SecretSendKey>,
      by: string,
    ) => Effect.Effect<boolean, SqlError>;
    /** Revokes a grant in force; the next send it covered asks again. True when there was one. */
    readonly revoke: (grant: SecretSendKey) => Effect.Effect<boolean, SqlError>;
  }
>()("@signalbox/cloud/user/SecretSends") {}

/** `UserStore`'s `0019_secret_sends` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE secret_sends (
    environment_id TEXT NOT NULL,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    granted_by TEXT NOT NULL,
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER
  )`;
  yield* sql`CREATE UNIQUE INDEX secret_sends_in_force
    ON secret_sends (environment_id, name, host) WHERE revoked_at IS NULL`;
});

const decodeRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      environment_id: Schema.String,
      name: Schema.String,
      host: Schema.String,
      granted_at: Schema.Number,
    }),
  ),
);

export const layer = Layer.effect(
  SecretSends,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const inForce: SecretSends["Service"]["inForce"] = Effect.map(
      sql`SELECT environment_id, name, host, granted_at FROM secret_sends
        WHERE revoked_at IS NULL ORDER BY environment_id, name, host`,
      (rows) =>
        decodeRows(rows).map((row) => ({
          environmentId: row.environment_id as OnePasswordEnvironmentId,
          name: row.name,
          host: row.host,
          grantedAt: row.granted_at,
        })),
    );

    const allowed: SecretSends["Service"]["allowed"] = (host, sends) =>
      Effect.map(
        sql<{ readonly environment_id: string; readonly name: string }>`SELECT environment_id, name
          FROM secret_sends WHERE revoked_at IS NULL AND host = ${host}`,
        (rows) => {
          const granted = new Set(rows.map((row) => `${row.environment_id} ${row.name}`));
          return new Set(
            sends
              .filter(({ environmentId, name }) => granted.has(`${environmentId} ${name}`))
              .map(({ name }) => name),
          );
        },
      );

    const keep: SecretSends["Service"]["keep"] = (grants, by) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        let added = false;
        for (const { environmentId, name, host } of grants) {
          const rows = yield* sql`INSERT INTO secret_sends
            (environment_id, name, host, granted_by, granted_at)
            VALUES (${environmentId}, ${name}, ${host}, ${by}, ${now})
            ON CONFLICT DO NOTHING RETURNING name`;
          added ||= rows.length > 0;
        }
        return added;
      });

    const revoke: SecretSends["Service"]["revoke"] = ({ environmentId, name, host }) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* sql`UPDATE secret_sends SET revoked_at = ${now}
          WHERE revoked_at IS NULL AND environment_id = ${environmentId}
            AND name = ${name} AND host = ${host} RETURNING name`;
        return rows.length > 0;
      });

    return SecretSends.of({ inForce, allowed, keep, revoke });
  }),
);
