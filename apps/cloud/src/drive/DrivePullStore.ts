import { pullJson } from "@signalbox/runner-protocol/PullProtocol";
import type { PullResult, PullSaveRequest } from "@signalbox/runner-protocol/PullProtocol";
import { canWrite } from "./driveAccess.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";

import * as DriveRevisions from "./DriveRevisions.ts";
import type { DriveWriter } from "./DriveRevisionTypes.ts";
import type { Oid } from "./git/gitObjects.ts";

/** The pull's thread refs and its immutable outcome receipt share one SQLite transaction. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE drive_pull_receipts (
    thread_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (thread_id, operation_id)
  )`;
});

const decodeReceipts = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ request_json: Schema.String, result_json: Schema.String })),
);

export interface PullOperationsInput {
  readonly sql: SqlClient.SqlClient;
  readonly role: (userId: string) => Effect.Effect<SignalboxDriveRole | null, SqlError>;
  readonly threadRow: (
    threadId: string,
  ) => Effect.Effect<typeof DriveRevisions.ThreadRevisionRow.Type | null, SqlError>;
  readonly ref: (name: string) => Effect.Effect<Oid | null, SqlError>;
  readonly missing: (
    oids: ReadonlyArray<Oid>,
    visibleTo: string | null,
  ) => Effect.Effect<ReadonlyArray<Oid>, SqlError>;
  readonly isCommit: (oid: Oid) => Effect.Effect<boolean, SqlError>;
  readonly threadRef: (threadId: string) => string;
  readonly wipRef: (threadId: string) => string;
  readonly setRef: (name: string, oid: Oid, by: string) => Effect.Effect<void, SqlError>;
  readonly removeRef: (name: string) => Effect.Effect<void, SqlError>;
  readonly land: (
    name: string,
    before: Oid | null,
    after: Oid | null,
    by: { readonly threadId: string },
  ) => Effect.Effect<void, SqlError>;
}

export const makeOperations = (input: PullOperationsInput) => {
  const { sql } = input;
  const receiptRow = (threadId: string, id: string) =>
    sql`SELECT request_json, result_json FROM drive_pull_receipts
      WHERE thread_id = ${threadId} AND operation_id = ${id}`.pipe(
      Effect.map((rows) => decodeReceipts(rows)[0] ?? null),
    );

  const pullReceipt = (writer: DriveWriter, id: string) =>
    Effect.gen(function* () {
      if (!canWrite(yield* input.role(writer.userId))) return null;
      const thread = yield* input.threadRow(writer.threadId);
      if (thread === null || writer.generation < thread.generation) return null;
      const prior = yield* receiptRow(writer.threadId, id);
      return prior === null ? null : pullJson.result.decode(prior.result_json);
    });

  const savePull = (writer: DriveWriter, request: PullSaveRequest) =>
    Effect.gen(function* () {
      const { operation, result } = request;
      const refused = (
        reason: string,
        refs?: { readonly thread: Oid | null; readonly wip: Oid | null },
      ): PullResult => ({
        id: operation.id,
        target: operation.target,
        head: refs === undefined ? result.head : refs.thread,
        wip: refs === undefined ? result.wip : refs.wip,
        outcome: "refused",
        reason,
        hasWorkingTreeChanges: result.hasWorkingTreeChanges,
      });

      if (operation.id !== result.id || operation.target !== result.target) {
        return refused("The pull result does not match its operation.");
      }
      if (!canWrite(yield* input.role(writer.userId))) {
        return refused("You no longer have access to change this drive.");
      }

      const thread = yield* input.threadRow(writer.threadId);
      if (thread === null) return refused("This thread has no drive branch.");
      if (writer.generation !== thread.generation) {
        return refused("A newer machine of this thread writes here now.");
      }

      const encodedRequest = pullJson.save.encode(request);
      const existing = yield* receiptRow(writer.threadId, operation.id);
      if (existing !== null) {
        if (existing.request_json !== encodedRequest) {
          return refused("This pull operation id already names a different request.");
        }
        return pullJson.result.decode(existing.result_json);
      }

      const branch = input.threadRef(writer.threadId);
      const autosave = input.wipRef(writer.threadId);
      const currentThread = yield* input.ref(branch);
      const currentWip = yield* input.ref(autosave);
      let saved = result;
      if (thread.revision !== operation.revision) {
        saved = refused("The thread revision changed while pulling.", {
          thread: currentThread,
          wip: currentWip,
        });
      } else if (
        currentThread !== operation.expectedThread ||
        currentWip !== operation.expectedWip
      ) {
        saved = refused("The thread's saved work changed while pulling.", {
          thread: currentThread,
          wip: currentWip,
        });
      } else if (
        (result.outcome === "pulled" && result.head !== operation.target) ||
        (result.outcome === "up_to_date" && result.head !== currentThread) ||
        (result.outcome === "refused" &&
          (result.head !== currentThread || result.wip !== currentWip))
      ) {
        saved = refused("The pull result does not match the selected target or current branch.", {
          thread: currentThread,
          wip: currentWip,
        });
      } else {
        const proposed = [
          ...(result.outcome === "pulled" ? [operation.target] : []),
          ...(result.head === null ? [] : [result.head]),
          result.wip,
        ].filter((oid): oid is Oid => oid !== null);
        for (const oid of saved.outcome === "refused" ? [] : proposed) {
          if (!(yield* input.isCommit(oid)) || (yield* input.missing([oid], null)).length > 0) {
            saved = refused(`The drive does not have commit ${oid}.`, {
              thread: currentThread,
              wip: currentWip,
            });
            break;
          }
        }
        if (saved.outcome !== "refused" && result.outcome !== "refused") {
          if (result.outcome === "pulled" && currentThread !== result.head) {
            yield* input.land(branch, currentThread, result.head, { threadId: writer.threadId });
          }
          if (currentWip !== result.wip) {
            if (result.wip === null) {
              yield* input.removeRef(autosave);
            } else {
              yield* input.setRef(autosave, result.wip, writer.threadId);
            }
          }
        }
      }

      const now = yield* Clock.currentTimeMillis;
      yield* sql`INSERT INTO drive_pull_receipts
        (thread_id, operation_id, request_json, result_json, created_at)
        VALUES (${writer.threadId}, ${operation.id}, ${encodedRequest},
          ${pullJson.result.encode(saved)}, ${now})`;
      return saved;
    }).pipe(sql.withTransaction);

  return { savePull, pullReceipt };
};
