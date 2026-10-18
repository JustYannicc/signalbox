import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import {
  decodeHistoryRecord,
  HistoryTransferError,
  type HistoryRecord,
} from "./DriveHistoryTransfer.ts";

export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE drive_history_imports (
    transfer_id TEXT PRIMARY KEY,
    source_drive_id TEXT NOT NULL,
    head TEXT,
    created_at INTEGER NOT NULL,
    last_activity INTEGER NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE TABLE drive_history_import_packs (
    transfer_id TEXT NOT NULL,
    source_seq INTEGER NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    object_count INTEGER NOT NULL,
    storage_drive_id TEXT,
    PRIMARY KEY (transfer_id, source_seq),
    UNIQUE (transfer_id, name)
  )`;
  yield* sql`CREATE TABLE drive_history_import_entries (
    transfer_id TEXT NOT NULL,
    source_rowid INTEGER NOT NULL,
    pack TEXT NOT NULL,
    oid TEXT NOT NULL,
    type TEXT NOT NULL,
    offset INTEGER NOT NULL,
    length INTEGER NOT NULL,
    size INTEGER NOT NULL,
    shallow INTEGER NOT NULL,
    PRIMARY KEY (transfer_id, source_rowid)
  )`;
  yield* sql`CREATE TABLE drive_history_import_promised (
    transfer_id TEXT NOT NULL,
    source_rowid INTEGER NOT NULL,
    oid TEXT NOT NULL,
    size INTEGER,
    PRIMARY KEY (transfer_id, source_rowid)
  )`;
  yield* sql`CREATE TABLE drive_history_import_commits (
    transfer_id TEXT NOT NULL,
    oid TEXT NOT NULL,
    tree TEXT NOT NULL,
    author_name TEXT NOT NULL,
    author_email TEXT NOT NULL,
    time INTEGER NOT NULL,
    message TEXT NOT NULL,
    PRIMARY KEY (transfer_id, oid)
  )`;
  yield* sql`CREATE TABLE drive_history_import_parents (
    transfer_id TEXT NOT NULL,
    oid TEXT NOT NULL,
    position INTEGER NOT NULL,
    parent TEXT NOT NULL,
    PRIMARY KEY (transfer_id, oid, position)
  )`;
});

const BATCH_SIZE = 8;

const stageTables = [
  "drive_history_import_entries",
  "drive_history_import_promised",
  "drive_history_import_commits",
  "drive_history_import_parents",
  "drive_history_import_packs",
];

export const prepareHistoryImport = Effect.fn("DriveHistory.prepareHistoryImport")(function* (
  transferId: string,
  sourceDriveId: string,
  head: string | null,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM drive_history_imports WHERE last_activity < ${now - 7 * 24 * 60 * 60 * 1000}`;
  for (const table of stageTables) {
    yield* sql`DELETE FROM ${sql(table)} WHERE rowid IN (
        SELECT staged.rowid FROM ${sql(table)} staged LEFT JOIN drive_history_imports active
          ON active.transfer_id = staged.transfer_id WHERE active.transfer_id IS NULL LIMIT 256)`;
  }
  yield* sql`INSERT INTO drive_history_imports
      (transfer_id, source_drive_id, head, created_at, last_activity, complete)
      VALUES (${transferId}, ${sourceDriveId}, ${head}, ${now}, ${now}, 0)`;
});

/** Streams records into hidden per-transfer tables using one short transaction per batch. */
export const importHistoryData = Effect.fn("DriveHistory.importHistoryData")(function* (
  data: ReadableStream<Uint8Array>,
  transferId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  let ended = false;
  const persist = (records: ReadonlyArray<HistoryRecord>) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const active = yield* sql`UPDATE drive_history_imports SET last_activity = ${now}
        WHERE transfer_id = ${transferId} RETURNING transfer_id`;
      if (active.length === 0)
        return yield* new HistoryTransferError({ cause: "History transfer expired. Try again." });
      for (const record of records) {
        if (ended)
          return yield* new HistoryTransferError({ cause: "Records after the history end." });
        if (record._tag === "end") {
          ended = true;
          yield* sql`UPDATE drive_history_imports SET complete = 1 WHERE transfer_id = ${transferId}`;
        } else if (record._tag === "pack") {
          const pack = record.row;
          yield* sql`INSERT OR IGNORE INTO drive_history_import_packs
            (transfer_id, source_seq, name, size, object_count, storage_drive_id)
            VALUES (${transferId}, ${pack.seq}, ${pack.name}, ${pack.size},
              ${pack.object_count}, ${pack.storage_drive_id})`;
        } else if (record._tag === "promised") {
          const row = record.row;
          yield* sql`INSERT OR IGNORE INTO drive_history_import_promised
            (transfer_id, source_rowid, oid, size)
            VALUES (${transferId}, ${row.rowid}, ${row.oid}, ${row.size})`;
        } else {
          const entry = record.row;
          yield* sql`INSERT OR IGNORE INTO drive_history_import_entries
            (transfer_id, source_rowid, pack, oid, type, offset, length, size, shallow)
            VALUES (${transferId}, ${entry.rowid}, ${entry.pack}, ${entry.oid}, ${entry.type},
              ${entry.offset}, ${entry.length}, ${entry.size}, ${entry.shallow})`;
          if (entry.type === "commit") {
            yield* sql`INSERT OR IGNORE INTO drive_history_import_commits
              (transfer_id, oid, tree, author_name, author_email, time, message)
              VALUES (${transferId}, ${entry.oid}, ${entry.tree}, ${entry.author_name},
                ${entry.author_email}, ${entry.time}, ${entry.message})`;
            for (const [position, parent] of (entry.parents == null || entry.parents === ""
              ? []
              : entry.parents.split(",")
            ).entries()) {
              yield* sql`INSERT OR IGNORE INTO drive_history_import_parents
                (transfer_id, oid, position, parent)
                VALUES (${transferId}, ${entry.oid}, ${position}, ${parent})`;
            }
          }
        }
      }
    }).pipe(sql.withTransaction);

  yield* Stream.fromReadableStream({
    evaluate: () => data,
    onError: (cause) => new HistoryTransferError({ cause }),
  }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line !== ""),
    Stream.mapEffect((line) =>
      decodeHistoryRecord(line).pipe(
        Effect.mapError((cause) => new HistoryTransferError({ cause })),
      ),
    ),
    Stream.grouped(BATCH_SIZE),
    Stream.runForEach((records) => persist(Array.from(records))),
  );
  if (!ended) return yield* new HistoryTransferError({ cause: "History transfer was incomplete." });
});

/** Copies complete staged metadata into the empty drive; caller publishes refs in the same transaction. */
export const publishHistoryData = Effect.fn("DriveHistory.publishHistoryData")(function* (
  transferId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const unmatched = yield* sql<{ readonly count: number }>`SELECT count(*) AS count
    FROM drive_history_import_entries e LEFT JOIN drive_history_import_packs p
      ON p.transfer_id = e.transfer_id AND p.name = e.pack
    WHERE e.transfer_id = ${transferId} AND p.name IS NULL`;
  if (unmatched[0]!.count !== 0) {
    return yield* new HistoryTransferError({ cause: "History contains entries without a pack." });
  }
  yield* sql`INSERT INTO packs (name, size, object_count, thread_id, created_at, private_to, storage_drive_id)
    SELECT name, size, object_count, 'history', 0, NULL, storage_drive_id
    FROM drive_history_import_packs WHERE transfer_id = ${transferId} ORDER BY source_seq`;
  yield* sql`INSERT OR IGNORE INTO objects (oid, pack_seq, offset, length, type, size)
    SELECT e.oid, p.seq, e.offset, e.length, e.type, e.size
    FROM drive_history_import_entries e JOIN packs p ON p.name = e.pack
    WHERE e.transfer_id = ${transferId}`;
  yield* sql`INSERT INTO pack_entries (pack_seq, offset, oid, length, type, size)
    SELECT p.seq, e.offset, e.oid, e.length, e.type, e.size
    FROM drive_history_import_entries e JOIN packs p ON p.name = e.pack
    WHERE e.transfer_id = ${transferId}`;
  yield* sql`INSERT OR IGNORE INTO shallow (oid, pack_seq)
    SELECT e.oid, p.seq FROM drive_history_import_entries e JOIN packs p ON p.name = e.pack
    WHERE e.transfer_id = ${transferId} AND e.shallow <> 0`;
  yield* sql`INSERT OR IGNORE INTO commits (oid, tree, author_name, author_email, time, message)
    SELECT oid, tree, author_name, author_email, time, message
    FROM drive_history_import_commits WHERE transfer_id = ${transferId}`;
  yield* sql`INSERT OR IGNORE INTO commit_parents (oid, position, parent)
    SELECT oid, position, parent FROM drive_history_import_parents WHERE transfer_id = ${transferId}`;
  yield* sql`INSERT OR IGNORE INTO promised (oid, size)
    SELECT oid, size FROM drive_history_import_promised WHERE transfer_id = ${transferId}`;
});

export const removeHistoryImport = Effect.fn("DriveHistory.removeHistoryImport")(function* (
  transferId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const table of stageTables) {
    yield* sql`DELETE FROM ${sql(table)} WHERE transfer_id = ${transferId}`;
  }
  yield* sql`DELETE FROM drive_history_imports WHERE transfer_id = ${transferId}`;
});
