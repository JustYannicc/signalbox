import { SecretRef, SecretRequestError, type TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Private custody, separate from events, projections, session rows and search. */
const Row = Schema.Struct({
  request_id: Schema.String,
  run_id: Schema.String,
  attempt_id: Schema.String,
  generation: Schema.Number,
  ref: SecretRef,
  value: Schema.NullOr(Schema.String),
  saved_at: Schema.NullOr(Schema.Number),
  consumed: Schema.Number,
});
const decode = Schema.decodeUnknownSync(Schema.Array(Row));
export type SecretBinding = {
  readonly requestId: TurnItemId;
  readonly runId: string;
  readonly attemptId: string;
  readonly generation: number;
};

export class ThreadSecretStore extends Context.Service<
  ThreadSecretStore,
  {
    readonly open: (binding: SecretBinding) => Effect.Effect<void, SecretRequestError>;
    readonly read: (
      requestId: TurnItemId,
    ) => Effect.Effect<typeof Row.Type | null, SecretRequestError>;
    readonly save: (
      requestId: TurnItemId,
      value: string,
      now: number,
    ) => Effect.Effect<void, SecretRequestError>;
    readonly consume: (
      ref: SecretRef,
      runId: string,
      attemptId: string,
      generation: number,
      now: number,
    ) => Effect.Effect<string, SecretRequestError>;
  }
>()("@signalbox/cloud/thread/secrets/ThreadSecretStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  yield* sql`CREATE TABLE IF NOT EXISTS signalbox_secret_requests (
    request_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
    generation INTEGER NOT NULL, ref TEXT NOT NULL UNIQUE, value TEXT,
    saved_at INTEGER, consumed INTEGER NOT NULL DEFAULT 0
  )`.pipe(Effect.orDie);
  const read: ThreadSecretStore["Service"]["read"] = (requestId) =>
    sql`SELECT * FROM signalbox_secret_requests WHERE request_id = ${requestId}`.pipe(
      Effect.map((rows) => decode(rows)[0] ?? null),
      Effect.mapError(() => new SecretRequestError({ reason: "read_failed" })),
    );
  return ThreadSecretStore.of({
    open: (binding) =>
      Effect.gen(function* () {
        const cutoff = (yield* Clock.currentTimeMillis) - 86_400_000;
        yield* sql`UPDATE signalbox_secret_requests SET value = NULL, consumed = 1
        WHERE saved_at < ${cutoff} AND value IS NOT NULL`;
        const ref = SecretRef.make(
          `secret-ref:${(yield* crypto.randomUUIDv4()).replaceAll("-", "")}`,
        );
        yield* sql`INSERT INTO signalbox_secret_requests
        (request_id, run_id, attempt_id, generation, ref)
        VALUES (${binding.requestId}, ${binding.runId}, ${binding.attemptId}, ${binding.generation}, ${ref})
        ON CONFLICT (request_id) DO NOTHING`;
      }).pipe(Effect.mapError(() => new SecretRequestError({ reason: "store_failed" }))),
    read,
    save: (requestId, value, now) =>
      sql`UPDATE signalbox_secret_requests SET value = ${value}, saved_at = ${now}
        WHERE request_id = ${requestId} AND value IS NULL AND consumed = 0`.pipe(
        Effect.asVoid,
        Effect.mapError(() => new SecretRequestError({ reason: "store_failed" })),
      ),
    consume: (ref, runId, attemptId, generation, now) =>
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          if (!/^secret-ref:[0-9a-f]{32}$/.test(ref))
            return yield* new SecretRequestError({ reason: "invalid_ref" });
          const rows = yield* sql`SELECT * FROM signalbox_secret_requests WHERE ref = ${ref}`;
          const row = decode(rows)[0];
          if (
            row === undefined ||
            row.value === null ||
            row.consumed !== 0 ||
            row.run_id !== runId ||
            row.attempt_id !== attemptId ||
            row.generation !== generation
          ) {
            return yield* new SecretRequestError({ reason: "ref_unavailable" });
          }
          if (row.saved_at === null || now - row.saved_at > 86_400_000) {
            yield* sql`UPDATE signalbox_secret_requests SET value = NULL, consumed = 1 WHERE ref = ${ref}`;
            return yield* new SecretRequestError({ reason: "ref_expired" });
          }
          yield* sql`UPDATE signalbox_secret_requests SET value = NULL, consumed = 1 WHERE ref = ${ref}`;
          return row.value;
        }).pipe(Effect.result, sql.withTransaction);
        return yield* Result.isFailure(result)
          ? Effect.fail(result.failure)
          : Effect.succeed(result.success);
      }).pipe(
        Effect.catchTags({
          SqlError: () => Effect.fail(new SecretRequestError({ reason: "consume_failed" })),
        }),
      ),
  });
});

export const layer = Layer.effect(ThreadSecretStore, make);
