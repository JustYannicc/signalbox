import type { DriveRemote } from "@signalbox/runner-protocol/DriveProtocol";
import type { SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { historyData, HistoryTransferError } from "./DriveHistoryTransfer.ts";
import * as HistoryImport from "./DriveHistoryImport.ts";

/** Immutable pack references and their indexes, never pack bytes or live refs. */
export interface HistorySnapshot {
  readonly sourceDriveId: string;
  readonly head: string | null;
  readonly remote: DriveRemote | null;
  readonly data: ReadableStream<Uint8Array>;
}

export interface HistoryOrigin {
  readonly sourceDriveId: string;
  readonly head: string | null;
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

export const createTransferTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE drive_history_exports (
    id TEXT PRIMARY KEY,
    last_activity INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE drive_history_export_packs (
    export_id TEXT NOT NULL,
    pack_seq INTEGER NOT NULL,
    PRIMARY KEY (export_id, pack_seq)
  )`;
  yield* HistoryImport.createTables;
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
  const newTransferId = sql<{ readonly id: string }>`SELECT lower(hex(randomblob(16))) AS id`.pipe(
    Effect.map((rows) => rows[0]!.id),
  );
  const packStorage = (name: string) =>
    sql<{
      readonly storage_drive_id: string | null;
    }>`SELECT storage_drive_id FROM packs WHERE name = ${name}`.pipe(
      Effect.map((rows) =>
        rows.length === 0 ? null : (rows[0]!.storage_drive_id ?? input.driveId),
      ),
    );

  const historyOrigin = (userId: string): Effect.Effect<HistoryOrigin | null, SqlError> =>
    Effect.gen(function* () {
      if ((yield* input.role(userId)) === null) return null;
      const [origin] = decodeOrigins(
        yield* sql`SELECT source_drive_id, head FROM drive_history_origin WHERE id = 1`,
      );
      return origin === undefined
        ? null
        : { sourceDriveId: origin.source_drive_id, head: origin.head };
    });

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
      const transferId = yield* newTransferId;
      const now = yield* Clock.currentTimeMillis;
      yield* sql`DELETE FROM drive_history_exports
        WHERE last_activity < ${now - 7 * 24 * 60 * 60 * 1000}`;
      yield* sql`DELETE FROM drive_history_export_packs WHERE rowid IN (
        SELECT p.rowid FROM drive_history_export_packs p LEFT JOIN drive_history_exports e
          ON e.id = p.export_id WHERE e.id IS NULL LIMIT 256)`;
      yield* sql`INSERT INTO drive_history_exports (id, last_activity)
        VALUES (${transferId}, ${now})`;
      yield* sql`INSERT INTO drive_history_export_packs (export_id, pack_seq)
        SELECT ${transferId}, seq FROM packs
        WHERE seq <= ${boundary!.maxPackSeq} AND private_to IS NULL`;
      return {
        _tag: "ok",
        history: {
          sourceDriveId: input.driveId,
          head: yield* input.ref("main"),
          remote: remote === null ? null : { ...remote, mode: "source" as const },
          transferId,
          maxPackSeq: boundary!.maxPackSeq,
          maxPromiseRow: boundary!.maxPromiseRow,
        },
      } as const;
    }).pipe(
      sql.withTransaction,
      Effect.flatMap((result): Effect.Effect<HistoryResult, SqlError> => {
        if (result._tag === "refused") return Effect.succeed(result);
        const { transferId, maxPackSeq, maxPromiseRow, ...header } = result.history;
        return historyData(input.driveId, transferId, maxPackSeq, maxPromiseRow).pipe(
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
      const existing = yield* originResult(snapshot);
      if (existing !== null) return existing;
      const empty = yield* isEmpty;
      if (!empty || snapshot.sourceDriveId === input.driveId) {
        return { _tag: "refused", reason: "History needs a new, empty drive." } as const;
      }
      const importId = yield* newTransferId;
      const now = yield* Clock.currentTimeMillis;
      yield* HistoryImport.prepareHistoryImport(
        importId,
        snapshot.sourceDriveId,
        snapshot.head,
        now,
      ).pipe(Effect.provideService(SqlClient.SqlClient, sql), sql.withTransaction);
      return yield* Effect.gen(function* () {
        yield* HistoryImport.importHistoryData(snapshot.data, importId);
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            if ((yield* input.role(userId)) !== "owner") {
              return {
                _tag: "refused",
                reason: "Only the owner can start this drive's history.",
              } as const;
            }
            const existing = yield* originResult(snapshot);
            if (existing !== null) return existing;
            if (!(yield* isEmpty)) {
              return { _tag: "refused", reason: "History needs a new, empty drive." } as const;
            }
            const completed = yield* sql<{ readonly complete: number }>`SELECT complete
              FROM drive_history_imports WHERE transfer_id = ${importId}
                AND source_drive_id = ${snapshot.sourceDriveId} AND head IS ${snapshot.head}`;
            if (completed[0]?.complete !== 1) {
              return yield* new HistoryTransferError({ cause: "History transfer is incomplete." });
            }
            // The network is done. Only local metadata and refs are published together.
            yield* HistoryImport.publishHistoryData(importId);
            if (snapshot.remote !== null)
              yield* input.setRemote({ ...snapshot.remote, mode: "source" });
            if (snapshot.head !== null) yield* input.setRef("main", snapshot.head, userId);
            yield* sql`INSERT INTO drive_history_origin (id, source_drive_id, head)
              VALUES (1, ${snapshot.sourceDriveId}, ${snapshot.head})`;
            return {
              _tag: "ok",
              sourceDriveId: snapshot.sourceDriveId,
              head: snapshot.head,
            } as const;
          }),
        );
      }).pipe(
        Effect.ensuring(HistoryImport.removeHistoryImport(importId).pipe(Effect.ignore)),
        Effect.provideService(SqlClient.SqlClient, sql),
      );
    });

  const originResult = (snapshot: HistorySnapshot) =>
    Effect.map(sql`SELECT source_drive_id, head FROM drive_history_origin WHERE id = 1`, (rows) => {
      const [origin] = decodeOrigins(rows);
      if (origin === undefined) return null;
      return origin.source_drive_id === snapshot.sourceDriveId && origin.head === snapshot.head
        ? ({ _tag: "ok", sourceDriveId: origin.source_drive_id, head: origin.head } as const)
        : ({ _tag: "refused", reason: "This drive already has a different origin." } as const);
    });

  const isEmpty = Effect.map(
    sql<{
      readonly count: number;
    }>`SELECT (SELECT count(*) FROM refs) + (SELECT count(*) FROM packs) +
      (SELECT count(*) FROM threads) + (SELECT count(*) FROM remote) AS count`,
    (rows) => rows[0]!.count === 0,
  );

  return { packStorage, historyOrigin, history, startFromHistory };
};
