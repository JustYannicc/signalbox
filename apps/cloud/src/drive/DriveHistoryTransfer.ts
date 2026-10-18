import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

const Pack = Schema.Struct({
  seq: Schema.Number,
  name: Schema.String,
  size: Schema.Number,
  object_count: Schema.Number,
  storage_drive_id: Schema.NullOr(Schema.String),
});
const Entry = Schema.Struct({
  rowid: Schema.Number,
  pack: Schema.String,
  oid: Schema.String,
  type: Schema.Literals(["commit", "tree", "blob", "tag"]),
  offset: Schema.Number,
  length: Schema.Number,
  size: Schema.Number,
  shallow: Schema.Number,
  tree: Schema.NullOr(Schema.String),
  author_name: Schema.NullOr(Schema.String),
  author_email: Schema.NullOr(Schema.String),
  time: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
  parents: Schema.NullOr(Schema.String),
});
const PromiseRow = Schema.Struct({
  rowid: Schema.Number,
  oid: Schema.String,
  size: Schema.NullOr(Schema.Number),
});
const Record = Schema.Union([
  Schema.TaggedStruct("pack", { row: Pack }),
  Schema.TaggedStruct("entry", { row: Entry }),
  Schema.TaggedStruct("promised", { row: PromiseRow }),
  Schema.TaggedStruct("end", {}),
]);
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(Record));
export type HistoryRecord = typeof Record.Type;
export const decodeHistoryRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Record));
const decodePacks = Schema.decodeUnknownSync(Schema.Array(Pack));
const decodeEntries = Schema.decodeUnknownSync(Schema.Array(Entry));
const decodePromises = Schema.decodeUnknownSync(Schema.Array(PromiseRow));

export class HistoryTransferError extends Schema.TaggedError<HistoryTransferError>()(
  "HistoryTransferError",
  { cause: Schema.Defect() },
) {}

/** Each record travels as a stream chunk, outside the RPC's 32 MiB message limit. */
export const historyData = Effect.fn("DriveHistory.historyData")(function* (
  driveId: string,
  exportId: string,
  maxPackSeq: number,
  maxPromiseRow: number,
) {
  const sql = yield* SqlClient.SqlClient;
  // DO SQLite bounds an individual row at 2 MiB. Keep each read below 32 MiB too.
  const pageSize = 8;
  const pages = Stream.unfold(
    { phase: 0, after: 0 },
    (
      cursor,
    ): Effect.Effect<
      | readonly [
          ReadonlyArray<typeof Record.Type>,
          { readonly phase: number; readonly after: number },
        ]
      | undefined,
      SqlError | HistoryTransferError
    > =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const active = yield* sql`UPDATE drive_history_exports SET last_activity = ${now}
          WHERE id = ${exportId} RETURNING id`;
        if (active.length === 0)
          return yield* new HistoryTransferError({ cause: "History snapshot expired. Try again." });
        if (cursor.phase === 0) {
          const rows = decodePacks(
            yield* sql`SELECT p.seq, p.name, p.size, p.object_count,
        coalesce(p.storage_drive_id, ${driveId}) AS storage_drive_id
        FROM packs p JOIN drive_history_export_packs exported
          ON exported.pack_seq = p.seq AND exported.export_id = ${exportId}
        WHERE p.seq > ${cursor.after} AND p.seq <= ${maxPackSeq}
        ORDER BY p.seq LIMIT ${pageSize}`,
          );
          return [
            rows.map((row) => ({ _tag: "pack" as const, row })),
            rows.length === 0 ? { phase: 1, after: 0 } : { phase: 0, after: rows.at(-1)!.seq },
          ] as const;
        }
        if (cursor.phase === 1) {
          // Keep entries first so SQLite advances by rowid instead of sorting every page.
          const rows = decodeEntries(
            yield* sql`SELECT e.rowid, p.name AS pack, e.oid, e.type,
        e.offset, e.length, e.size,
        EXISTS(SELECT 1 FROM shallow s WHERE s.oid = e.oid AND s.pack_seq = p.seq) AS shallow,
        c.tree, c.author_name, c.author_email, c.time, c.message,
        (SELECT group_concat(parent, ',') FROM
          (SELECT parent FROM commit_parents WHERE oid = c.oid ORDER BY position)) AS parents
        FROM pack_entries e CROSS JOIN packs p ON p.seq = e.pack_seq
        LEFT JOIN commits c ON c.oid = e.oid AND e.type = 'commit'
        WHERE e.rowid > ${cursor.after} AND p.seq <= ${maxPackSeq}
          AND EXISTS (SELECT 1 FROM drive_history_export_packs exported
            WHERE exported.export_id = ${exportId} AND exported.pack_seq = p.seq)
        ORDER BY e.rowid LIMIT ${pageSize}`,
          );
          return [
            rows.map((row) => ({ _tag: "entry" as const, row })),
            rows.length === 0 ? { phase: 2, after: 0 } : { phase: 1, after: rows.at(-1)!.rowid },
          ] as const;
        }
        if (cursor.phase === 2) {
          const rows = decodePromises(
            yield* sql`SELECT rowid, oid, size FROM promised
        WHERE rowid > ${cursor.after} AND rowid <= ${maxPromiseRow} ORDER BY rowid LIMIT ${pageSize}`,
          );
          return [
            rows.map((row) => ({ _tag: "promised" as const, row })),
            rows.length === 0 ? { phase: 3, after: 0 } : { phase: 2, after: rows.at(-1)!.rowid },
          ] as const;
        }
        return cursor.phase === 3
          ? ([[{ _tag: "end" as const }], { phase: 4, after: 0 }] as const)
          : undefined;
      }),
  ).pipe(
    Stream.flatMap(Stream.fromArray),
    Stream.map((record) => `${encodeRecord(record)}\n`),
    Stream.encodeText,
    Stream.ensuring(
      Effect.gen(function* () {
        yield* sql`DELETE FROM drive_history_export_packs WHERE export_id = ${exportId}`;
        yield* sql`DELETE FROM drive_history_exports WHERE id = ${exportId}`;
      }).pipe(sql.withTransaction, Effect.ignore),
    ),
  );
  return yield* Stream.toReadableStreamEffect(pages);
});
