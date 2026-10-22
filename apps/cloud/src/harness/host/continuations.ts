import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { FacetStorage } from "../../kernel/FacetSqliteStorage.ts";
import { HarnessError } from "../Harness.ts";
import { HarnessContinuation, type HarnessContinuationPublisher } from "../HarnessContinuations.ts";

const codec = Schema.fromJsonString(Schema.toCodecJson(HarnessContinuation));
const encode = Schema.encodeSync(codec);
const decode = Schema.decodeSync(codec);

export const createContinuationJournal = (
  database: FacetStorage,
  publisher: HarnessContinuationPublisher,
  signal: AbortSignal,
) =>
  Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    yield* Effect.try({
      try: () =>
        database.sql.exec(
          "CREATE TABLE IF NOT EXISTS harness_continuation_requests (message_id TEXT PRIMARY KEY, request_json TEXT NOT NULL, published INTEGER NOT NULL CHECK(published IN (0, 1)))",
        ),
      catch: (cause) =>
        new HarnessError({
          operation: "journal",
          message: "Continuation journal could not be opened.",
          cause,
        }),
    });
    const publish = (supplied: HarnessContinuation) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const prepared = yield* Effect.try({
            try: () => {
              signal.throwIfAborted();
              const json = encode(supplied);
              const request = decode(json);
              return database.transactionSync(() => {
                const existing = [
                  ...database.sql.exec(
                    "SELECT request_json, published FROM harness_continuation_requests WHERE message_id=?",
                    request.messageId,
                  ),
                ][0];
                if (existing !== undefined) {
                  if (existing.request_json !== json)
                    throw new Error("Continuation identity conflicts with its journal");
                  if (existing.published !== 0 && existing.published !== 1)
                    throw new Error("Invalid continuation journal state");
                  return { request, published: existing.published === 1 };
                }
                database.sql.exec(
                  "INSERT INTO harness_continuation_requests VALUES (?, ?, 0)",
                  request.messageId,
                  json,
                );
                return { request, published: false };
              });
            },
            catch: (cause) =>
              new HarnessError({
                operation: "journal",
                message: "Continuation request could not be journaled.",
                cause,
              }),
          });
          if (prepared.published) return;
          yield* publisher.publish(prepared.request);
          yield* Effect.try({
            try: () => {
              signal.throwIfAborted();
              database.transactionSync(() =>
                database.sql.exec(
                  "UPDATE harness_continuation_requests SET published=1 WHERE message_id=?",
                  prepared.request.messageId,
                ),
              );
            },
            catch: (cause) =>
              new HarnessError({
                operation: "journal",
                message: "Continuation publication receipt could not be journaled.",
                cause,
              }),
          });
        }),
      );
    const replay = Effect.gen(function* () {
      const pending = yield* Effect.try({
        try: () =>
          [
            ...database.sql.exec(
              "SELECT request_json FROM harness_continuation_requests WHERE published=0 ORDER BY rowid",
            ),
          ].map((row) => {
            if (typeof row.request_json !== "string")
              throw new Error("Invalid continuation journal payload");
            return decode(row.request_json);
          }),
        catch: (cause) =>
          new HarnessError({
            operation: "journal",
            message: "Pending continuations could not be read.",
            cause,
          }),
      });
      yield* Effect.forEach(pending, publish, { discard: true });
    });
    return { publish, replay };
  });

export type ContinuationJournal = Effect.Success<ReturnType<typeof createContinuationJournal>>;
