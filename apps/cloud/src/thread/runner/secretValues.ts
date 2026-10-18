import { SecretValue } from "@signalbox/runner-protocol/SecretScrubber";
import type { RunId } from "@t3tools/contracts";
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
 * `registered` and `registeredRunId` identify the latest successful
 * registration. A new run or machine clears current values before it is sent.
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
  /** The run that registered last; null before any did. */
  readonly registeredRunId: string | null;
  /** Changes on every successful registration, including A-to-B-to-A rotations. */
  readonly revision: number;
  /** Only the latest complete registration may supply outbound substitutions. */
  readonly current: ReadonlyArray<SecretValue>;
  /** In the order they were first registered. */
  readonly values: ReadonlyArray<SecretValue>;
}

const decodeValues = Schema.decodeUnknownSync(Schema.Array(SecretValue));
const decodeRegistration = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      generation: Schema.Number,
      run_id: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodeRevision = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ revision: Schema.Number })),
);

export const readSecretValues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* Effect.gen(function* () {
    const values = yield* sql`SELECT name, value FROM secret_values ORDER BY rowid`;
    const registration =
      yield* sql`SELECT generation, run_id FROM secret_registration WHERE id = 1`;
    const currentRegistration =
      yield* sql`SELECT revision FROM secret_current_registration WHERE id = 1`;
    const current = yield* sql`SELECT name, value FROM secret_current_values ORDER BY name`;
    const registered = decodeRegistration(registration)[0];
    return {
      registered: registered?.generation ?? null,
      registeredRunId: registered?.run_id ?? null,
      revision: decodeRevision(currentRegistration)[0]?.revision ?? 0,
      values: decodeValues(values),
      current: decodeValues(current),
    } satisfies SecretValues;
  }).pipe(sql.withTransaction);
});

/** Revision alone, for egress decisions that must notice every current-value change. */
export const readSecretRevision = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{
    readonly revision: number;
  }>`SELECT revision FROM secret_current_registration WHERE id = 1`;
  return row?.revision ?? 0;
});

/** Starts a turn's secret view before its Runner receives `turn.start`. */
export const beginSecretRun = Effect.fn("beginSecretRun")(function* (
  generation: number,
  runId: RunId | null,
) {
  const sql = yield* SqlClient.SqlClient;
  const [active] = yield* sql<{
    readonly active_generation: number | null;
    readonly active_run_id: string | null;
  }>`SELECT active_generation, active_run_id FROM secret_current_registration WHERE id = 1`;
  if (active?.active_generation === generation && active.active_run_id === runId) return false;

  yield* sql`DELETE FROM secret_current_values`;
  yield* sql`UPDATE secret_current_registration
    SET active_generation = ${generation}, active_run_id = ${runId}, revision = revision + 1
    WHERE id = 1`;
  return true;
});

/** Callers run it with the current run marker and generation in their transaction. */
export const registerSecretValues = (
  generation: number,
  runId: RunId,
  secrets: ReadonlyArray<SecretValue>,
  current: ReadonlyArray<SecretValue>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [active] = yield* sql<{
      readonly active_generation: number | null;
      readonly active_run_id: string | null;
    }>`SELECT active_generation, active_run_id FROM secret_current_registration WHERE id = 1`;
    if (active?.active_generation !== generation || active.active_run_id !== runId) return false;

    yield* sql`DELETE FROM secret_current_values`;
    for (const { name, value } of current) {
      yield* sql`INSERT INTO secret_current_values (name, value) VALUES (${name}, ${value})
        ON CONFLICT (name) DO UPDATE SET value = excluded.value`;
    }
    for (const { name, value } of [...secrets, ...current]) {
      yield* sql`INSERT INTO secret_values (value, name) VALUES (${value}, ${name})
        ON CONFLICT (value) DO NOTHING`;
    }
    yield* sql`UPDATE secret_current_registration SET revision = revision + 1 WHERE id = 1`;
    yield* sql`INSERT INTO secret_registration (id, generation, run_id)
      VALUES (1, ${generation}, ${runId})
      ON CONFLICT (id) DO UPDATE SET generation = excluded.generation, run_id = excluded.run_id`;
    return true;
  });

/** Adds live-run identity without editing `0010` or `0012` after they shipped. */
export const migrateSecretRunIdentity = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE secret_registration ADD COLUMN run_id TEXT`;
  yield* sql`ALTER TABLE secret_current_registration ADD COLUMN active_generation INTEGER`;
  yield* sql`ALTER TABLE secret_current_registration ADD COLUMN active_run_id TEXT`;
  // Existing rows predate run-scoped fills; never promote their stale values or grants.
  yield* sql`DELETE FROM secret_current_values`;
  yield* sql`UPDATE secret_current_registration SET active_generation = NULL,
    active_run_id = NULL, revision = revision + 1 WHERE id = 1`;
  yield* sql`DELETE FROM secret_sources`;
});

/** No historical value is promoted on upgrade: a fresh registration is required. */
export const migrateCurrentSecretValues = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE secret_current_values (name TEXT PRIMARY KEY, value TEXT NOT NULL)`;
  yield* sql`CREATE TABLE secret_current_registration (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL)`;
  yield* sql`INSERT INTO secret_current_registration (id, revision) VALUES (1, 0)`;
});
