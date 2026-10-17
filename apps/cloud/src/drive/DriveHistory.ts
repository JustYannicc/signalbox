import type { DriveRemote } from "@signalbox/runner-protocol/DriveProtocol";
import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  historyData,
  importHistoryData,
  type HistoryTransferError,
} from "./DriveHistoryTransfer.ts";

/** Immutable pack references and their indexes, never pack bytes or live refs. */
export interface HistorySnapshot {
  readonly sourceDriveId: string;
  readonly head: string | null;
  readonly remote: DriveRemote | null;
  readonly data: ReadableStream<Uint8Array>;
}

export type HistoryResult =
  | { readonly _tag: "ok"; readonly history: HistorySnapshot }
  | { readonly _tag: "refused"; readonly reason: string };
export type HistoryStartResult =
  | { readonly _tag: "ok"; readonly sourceDriveId: string; readonly head: string | null }
  | { readonly _tag: "refused"; readonly reason: string };

export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE packs ADD COLUMN storage_drive_id TEXT`;
  yield* sql`CREATE TABLE drive_history_origin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    source_drive_id TEXT NOT NULL,
    head TEXT
  )`;
  yield* sql`ALTER TABLE remote ADD COLUMN mode TEXT`;
});

const Origin = Schema.Struct({
  source_drive_id: Schema.String,
  head: Schema.NullOr(Schema.String),
});
const decodeOrigins = Schema.decodeUnknownSync(Schema.Array(Origin));

export const makeOperations = (input: {
  readonly driveId: string;
  readonly sql: SqlClient.SqlClient;
  readonly role: (userId: string) => Effect.Effect<SignalboxDriveRole | null, SqlError>;
  readonly ref: (name: string) => Effect.Effect<string | null, SqlError>;
  readonly remote: Effect.Effect<DriveRemote | null, SqlError>;
  readonly setRemote: (remote: DriveRemote) => Effect.Effect<void, SqlError>;
  readonly setRef: (name: string, oid: string, by: string) => Effect.Effect<void, SqlError>;
}) => {
  const { sql } = input;
  const packStorage = (name: string) =>
    sql<{
      readonly storage_drive_id: string | null;
    }>`SELECT storage_drive_id FROM packs WHERE name = ${name}`.pipe(
      Effect.map((rows) =>
        rows.length === 0 ? null : (rows[0]!.storage_drive_id ?? input.driveId),
      ),
    );

  const history = (userId: string): Effect.Effect<HistoryResult, SqlError> =>
    Effect.gen(function* () {
      if ((yield* input.role(userId)) === null) {
        return { _tag: "refused", reason: "You don't have access to that drive." } as const;
      }
      const [boundary] = yield* sql<{
        readonly maxPackSeq: number;
        readonly maxPromiseRow: number;
      }>`SELECT
        coalesce((SELECT max(seq) FROM packs), 0) AS maxPackSeq,
        coalesce((SELECT max(rowid) FROM promised), 0) AS maxPromiseRow`;
      const remote = yield* input.remote;
      return {
        _tag: "ok",
        history: {
          sourceDriveId: input.driveId,
          head: yield* input.ref("main"),
          remote: remote === null ? null : { ...remote, mode: "source" as const },
          maxPackSeq: boundary!.maxPackSeq,
          maxPromiseRow: boundary!.maxPromiseRow,
        },
      } as const;
    }).pipe(
      sql.withTransaction,
      Effect.flatMap((result): Effect.Effect<HistoryResult, SqlError> => {
        if (result._tag === "refused") return Effect.succeed(result);
        const { maxPackSeq, maxPromiseRow, ...header } = result.history;
        return historyData(input.driveId, maxPackSeq, maxPromiseRow).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.map((data) => ({ _tag: "ok" as const, history: { ...header, data } })),
        );
      }),
    );

  const startFromHistory = (
    userId: string,
    snapshot: HistorySnapshot,
  ): Effect.Effect<HistoryStartResult, SqlError | HistoryTransferError> =>
    Effect.gen(function* () {
      if ((yield* input.role(userId)) !== "owner") {
        return {
          _tag: "refused",
          reason: "Only the owner can start this drive's history.",
        } as const;
      }
      const [origin] = decodeOrigins(
        yield* sql`SELECT source_drive_id, head FROM drive_history_origin WHERE id = 1`,
      );
      if (origin !== undefined) {
        return origin.source_drive_id === snapshot.sourceDriveId && origin.head === snapshot.head
          ? ({ _tag: "ok", sourceDriveId: origin.source_drive_id, head: origin.head } as const)
          : ({ _tag: "refused", reason: "This drive already has a different origin." } as const);
      }
      const rows = yield* sql<{ readonly count: number }>`SELECT
        (SELECT count(*) FROM refs) + (SELECT count(*) FROM packs) +
        (SELECT count(*) FROM threads) + (SELECT count(*) FROM remote) AS count`;
      if (rows[0]!.count !== 0 || snapshot.sourceDriveId === input.driveId) {
        return { _tag: "refused", reason: "History needs a new, empty drive." } as const;
      }
      // Pack bytes are immutable and retained for good. The destination indexes
      // the same packs, including their physical origin through any earlier fork.
      yield* importHistoryData(snapshot.data).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      if (snapshot.remote !== null) yield* input.setRemote({ ...snapshot.remote, mode: "source" });
      if (snapshot.head !== null) yield* input.setRef("main", snapshot.head, userId);
      yield* sql`INSERT INTO drive_history_origin (id, source_drive_id, head)
        VALUES (1, ${snapshot.sourceDriveId}, ${snapshot.head})`;
      return { _tag: "ok", sourceDriveId: snapshot.sourceDriveId, head: snapshot.head } as const;
    }).pipe(sql.withTransaction);

  return { packStorage, history, startFromHistory };
};
