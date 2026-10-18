import { PositiveInt } from "@t3tools/contracts";
import { DriveRemote, InitialRemoteHead, Oid } from "@signalbox/runner-protocol/DriveProtocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import { canWrite } from "./driveAccess.ts";

export interface PrepareThreadRequest {
  readonly operationId: string;
  readonly threadId: string;
  readonly repository: string;
  readonly number: number;
  readonly headSha: typeof Oid.Type;
}

export type PrepareThreadResult =
  | { readonly _tag: "ok" }
  | { readonly _tag: "refused"; readonly reason: string };

export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE drive_thread_seeds (
    thread_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL UNIQUE,
    repository TEXT NOT NULL,
    number INTEGER NOT NULL CHECK (number > 0),
    head_sha TEXT NOT NULL CHECK (length(head_sha) = 40),
    created_at INTEGER NOT NULL
  )`;
  // Keep consumption separate so the selected head stays immutable and replayable.
  yield* sql`CREATE TABLE drive_thread_seed_consumptions (
    thread_id TEXT PRIMARY KEY,
    consumed_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES drive_thread_seeds(thread_id)
  )`;
});

const ThreadSeedRow = Schema.Struct({
  thread_id: Schema.String,
  operation_id: Schema.String,
  repository: Schema.String,
  number: PositiveInt,
  head_sha: Oid,
});
const decodeThreadSeedRows = Schema.decodeUnknownSync(Schema.Array(ThreadSeedRow));
const isPositiveInt = Schema.is(PositiveInt);
const isOid = Schema.is(Oid);

export interface ThreadSeedOperationsInput {
  readonly sql: SqlClient.SqlClient;
  readonly role: (userId: string) => Effect.Effect<SignalboxDriveRole | null, SqlError>;
  readonly remote: () => Effect.Effect<typeof DriveRemote.Type | null, SqlError>;
  readonly threadStarted: (threadId: string) => Effect.Effect<boolean, SqlError>;
}

export const makeOperations = (input: ThreadSeedOperationsInput) => {
  const { sql } = input;
  const threadSeed = (threadId: string) =>
    sql`SELECT thread_id, operation_id, repository, number, head_sha
      FROM drive_thread_seeds WHERE thread_id = ${threadId}`.pipe(
      Effect.map((rows) => decodeThreadSeedRows(rows)[0] ?? null),
    );

  const pendingInitialRemoteHead = (threadId: string | null) =>
    Effect.gen(function* () {
      if (threadId === null) return null;
      const seed = yield* threadSeed(threadId);
      if (seed === null) return null;
      const consumed = yield* sql`SELECT thread_id FROM drive_thread_seed_consumptions
        WHERE thread_id = ${threadId}`.pipe(Effect.map((rows) => rows.length > 0));
      if (consumed) return null;
      return {
        repository: seed.repository,
        number: seed.number,
        headSha: seed.head_sha,
      } satisfies typeof InitialRemoteHead.Type;
    });

  const prepareThread: (
    userId: string,
    request: PrepareThreadRequest,
  ) => Effect.Effect<PrepareThreadResult, SqlError> = (userId, request) =>
    Effect.gen(function* () {
      if (!canWrite(yield* input.role(userId))) {
        return {
          _tag: "refused",
          reason: "You no longer have access to change this drive.",
        } as const;
      }
      if (
        request.operationId.trim() === "" ||
        request.threadId.trim() === "" ||
        request.repository.trim() === "" ||
        !isPositiveInt(request.number) ||
        !isOid(request.headSha)
      ) {
        return { _tag: "refused", reason: "A pull-request seed needs a valid selection." } as const;
      }
      const source = yield* input.remote();
      if (source === null || source.repository !== request.repository) {
        return {
          _tag: "refused",
          reason: "This pull request does not match the drive's remote repository.",
        } as const;
      }

      const existing = yield* threadSeed(request.threadId);
      if (existing !== null) {
        if (
          existing.operation_id === request.operationId &&
          existing.repository === request.repository &&
          existing.number === request.number &&
          existing.head_sha === request.headSha
        ) {
          return { _tag: "ok" } as const;
        }
        return {
          _tag: "refused",
          reason:
            existing.operation_id === request.operationId
              ? "This operation id already belongs to a different pull-request selection."
              : "This thread already has a different pull-request seed.",
        } as const;
      }

      const operation = yield* sql`SELECT thread_id FROM drive_thread_seeds
        WHERE operation_id = ${request.operationId}`;
      if (operation.length > 0) {
        return {
          _tag: "refused",
          reason: "This operation id already belongs to another thread.",
        } as const;
      }
      if (yield* input.threadStarted(request.threadId)) {
        return {
          _tag: "refused",
          reason: "The thread has already started on this drive.",
        } as const;
      }

      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO drive_thread_seeds
        (thread_id, operation_id, repository, number, head_sha, created_at)
        VALUES (${request.threadId}, ${request.operationId}, ${request.repository},
          ${request.number}, ${request.headSha}, ${now})`;
      return { _tag: "ok" } as const;
    }).pipe(sql.withTransaction);

  const consume = (threadId: string) =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      sql`INSERT INTO drive_thread_seed_consumptions (thread_id, consumed_at)
        VALUES (${threadId}, ${now})`.pipe(Effect.asVoid),
    );

  return { pendingInitialRemoteHead, prepareThread, consume };
};
