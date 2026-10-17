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
const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(Record));
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
      SqlError
    > =>
      Effect.gen(function* () {
        if (cursor.phase === 0) {
          const rows = decodePacks(
            yield* sql`SELECT seq, name, size, object_count,
        coalesce(storage_drive_id, ${driveId}) AS storage_drive_id FROM packs
        WHERE seq > ${cursor.after} AND seq <= ${maxPackSeq} AND private_to IS NULL
        ORDER BY seq LIMIT ${pageSize}`,
          );
          return [
            rows.map((row) => ({ _tag: "pack" as const, row })),
            rows.length === 0 ? { phase: 1, after: 0 } : { phase: 0, after: rows.at(-1)!.seq },
          ] as const;
        }
        if (cursor.phase === 1) {
          const rows = decodeEntries(
            yield* sql`SELECT e.rowid, p.name AS pack, e.oid, e.type,
        e.offset, e.length, e.size,
        EXISTS(SELECT 1 FROM shallow s WHERE s.oid = e.oid AND s.pack_seq = p.seq) AS shallow,
        c.tree, c.author_name, c.author_email, c.time, c.message,
        (SELECT group_concat(parent, ',') FROM
          (SELECT parent FROM commit_parents WHERE oid = c.oid ORDER BY position)) AS parents
        FROM pack_entries e JOIN packs p ON p.seq = e.pack_seq
        LEFT JOIN commits c ON c.oid = e.oid AND e.type = 'commit'
        WHERE e.rowid > ${cursor.after} AND p.seq <= ${maxPackSeq} AND p.private_to IS NULL
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
  );
  return yield* Stream.toReadableStreamEffect(pages);
});

/** The caller's transaction publishes no refs until the complete stream is indexed. */
export const importHistoryData = Effect.fn("DriveHistory.importHistoryData")(function* (
  data: ReadableStream<Uint8Array>,
) {
  const sql = yield* SqlClient.SqlClient;
  let ended = false;
  yield* Stream.fromReadableStream({
    evaluate: () => data,
    onError: (cause) => new HistoryTransferError({ cause }),
  }).pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line !== ""),
    Stream.mapEffect((line) =>
      decodeRecord(line).pipe(Effect.mapError((cause) => new HistoryTransferError({ cause }))),
    ),
    Stream.runForEach((record) =>
      Effect.gen(function* () {
        if (ended)
          return yield* new HistoryTransferError({ cause: "Records after the history end." });
        if (record._tag === "end") {
          ended = true;
          return;
        }
        if (record._tag === "pack") {
          const pack = record.row;
          yield* sql`INSERT INTO packs (name, size, object_count, thread_id, created_at, private_to, storage_drive_id)
          VALUES (${pack.name}, ${pack.size}, ${pack.object_count}, 'history', 0, NULL, ${pack.storage_drive_id})`;
        } else if (record._tag === "promised") {
          const row = record.row;
          yield* sql`INSERT OR IGNORE INTO promised (oid, size) VALUES (${row.oid}, ${row.size})`;
        } else {
          const entry = record.row;
          const rows = yield* sql<{
            readonly seq: number;
          }>`SELECT seq FROM packs WHERE name = ${entry.pack}`;
          if (rows[0] === undefined)
            return yield* new HistoryTransferError({ cause: "Missing history pack." });
          const seq = rows[0].seq;
          yield* sql`INSERT OR IGNORE INTO objects (oid, pack_seq, offset, length, type, size)
          VALUES (${entry.oid}, ${seq}, ${entry.offset}, ${entry.length}, ${entry.type}, ${entry.size})`;
          yield* sql`INSERT INTO pack_entries (pack_seq, offset, oid, length, type, size)
          VALUES (${seq}, ${entry.offset}, ${entry.oid}, ${entry.length}, ${entry.type}, ${entry.size})`;
          if (entry.shallow !== 0)
            yield* sql`INSERT OR IGNORE INTO shallow (oid, pack_seq) VALUES (${entry.oid}, ${seq})`;
          if (entry.type === "commit") {
            yield* sql`INSERT OR IGNORE INTO commits (oid, tree, author_name, author_email, time, message)
            VALUES (${entry.oid}, ${entry.tree}, ${entry.author_name}, ${entry.author_email}, ${entry.time}, ${entry.message})`;
            for (const [position, parent] of (entry.parents == null || entry.parents === ""
              ? []
              : entry.parents.split(",")
            ).entries()) {
              yield* sql`INSERT OR IGNORE INTO commit_parents (oid, position, parent) VALUES (${entry.oid}, ${position}, ${parent})`;
            }
          }
        }
      }),
    ),
  );
  if (!ended) return yield* new HistoryTransferError({ cause: "History transfer was incomplete." });
});
