import { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The values of a thread's secrets, as its machine registered them (#591,
 * `SecretsProtocol.ts`), for the ModelGateway to scrub from every model
 * request. They join and are never dropped while the thread lives: a value
 * rotated in 1Password may still sit in the conversation the harness sends.
 * Stored as they are, like the owner's 1Password token in their object, which
 * reads all of them anyway: Durable Object storage is encrypted at rest.
 * Never log them. Historical values also detect and redact outbound echoes;
 * only the latest complete registration may fill outbound placeholders.
 *
 * `registered` is the machine generation that last registered: the gateway
 * serves a turn with secrets only once the machine running it has.
 */

/** Part of `ThreadStore`'s `0010_secret_values` migration. */
export const migrateSecretValues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE secret_values (
    value TEXT PRIMARY KEY,
    name TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE secret_registration (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL
  )`;
});

export interface SecretValues {
  /** The machine generation that registered last; null before any did. */
  readonly registered: number | null;
  /** Changes on every successful registration, including A-to-B-to-A rotations. */
  readonly revision: number;
  /** Only the latest complete registration may supply outbound substitutions. */
  readonly current: ReadonlyArray<SecretValue>;
  /** In the order they were first registered. */
  readonly values: ReadonlyArray<SecretValue>;
}

const decodeValues = Schema.decodeUnknownSync(Schema.Array(SecretValue));
const decodeRegistration = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ generation: Schema.Number, revision: Schema.Number })),
);

export const readSecretValues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.gen(function* () {
    const values = yield* sql`SELECT name, value FROM secret_values ORDER BY rowid`;
    const registration = yield* sql`SELECT generation, revision FROM secret_registration
    CROSS JOIN secret_current_registration WHERE secret_registration.id = 1 AND secret_current_registration.id = 1`;
    const current = yield* sql`SELECT name, value FROM secret_current_values ORDER BY name`;
    return {
      registered: decodeRegistration(registration)[0]?.generation ?? null,
      revision: decodeRegistration(registration)[0]?.revision ?? 0,
      values: decodeValues(values),
      current: decodeValues(current),
    } satisfies SecretValues;
  }).pipe(sql.withTransaction);
});

/** Callers run it in the transaction that checks `generation` still holds the lease. */
export const registerSecretValues = (generation: number, secrets: ReadonlyArray<SecretValue>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM secret_current_values`;
    for (const { name, value } of secrets) {
      yield* sql`INSERT INTO secret_current_values (name, value) VALUES (${name}, ${value})
        ON CONFLICT (name) DO UPDATE SET value = excluded.value`;
      yield* sql`INSERT INTO secret_values (value, name) VALUES (${value}, ${name})
        ON CONFLICT (value) DO NOTHING`;
    }
    yield* sql`UPDATE secret_current_registration SET revision = revision + 1 WHERE id = 1`;
    yield* sql`INSERT INTO secret_registration (id, generation) VALUES (1, ${generation})
      ON CONFLICT (id) DO UPDATE SET generation = excluded.generation`;
  });

/** No historical value is promoted on upgrade: a fresh registration is required. */
export const migrateCurrentSecretValues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE secret_current_values (name TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  yield* sql`CREATE TABLE secret_current_registration (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL)`;
  yield* sql`INSERT INTO secret_current_registration (id, revision) VALUES (1, 0)`;
});
