import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const FORMAT_VERSION = 1;
export const MAX_CHUNK_BYTES = 64 * 1024;
export const MAX_BATCH_BYTES = 256 * 1024;
export const MAX_BATCH_CHUNKS = 64;
export const MAX_CHECKPOINT_BYTES = 256 * 1024;
export const MAX_READ_ROWS = 64;

export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE drive_metadata_objects (
    oid TEXT NOT NULL,
    format_version INTEGER NOT NULL,
    source_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
    bytes_written INTEGER NOT NULL DEFAULT 0 CHECK (bytes_written >= 0),
    checkpoint TEXT CHECK (length(CAST(checkpoint AS BLOB)) <= 262144),
    complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
    PRIMARY KEY (oid, format_version)
  ) WITHOUT ROWID`;
  yield* sql`CREATE TABLE drive_metadata_chunks (
    oid TEXT NOT NULL,
    format_version INTEGER NOT NULL,
    byte_offset INTEGER NOT NULL CHECK (byte_offset >= 0),
    data BLOB NOT NULL CHECK (length(data) BETWEEN 1 AND 65536),
    PRIMARY KEY (oid, format_version, byte_offset),
    FOREIGN KEY (oid, format_version) REFERENCES drive_metadata_objects (oid, format_version)
  ) WITHOUT ROWID`;
});

const OffsetRow = Schema.Struct({ byte_offset: Schema.Number });
const ChunkRow = Schema.Struct({ byte_offset: Schema.Number, data: Schema.Uint8Array });
const decodeOffsets = Schema.decodeUnknownEffect(Schema.Array(OffsetRow));
const decodeChunks = Schema.decodeUnknownEffect(Schema.Array(ChunkRow));

/** The predecessor lookup and keyset range both use the composite primary key. */
export const readChunks = Effect.fn("DriveMetadata.readChunks")(function* (
  oid: string,
  offset: number,
  length: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const predecessors = yield* sql`SELECT byte_offset FROM drive_metadata_chunks
    WHERE oid = ${oid} AND format_version = ${FORMAT_VERSION} AND byte_offset <= ${offset}
    ORDER BY byte_offset DESC LIMIT 1`;
  const first = (yield* decodeOffsets(predecessors))[0];
  if (first === undefined) return [];

  // Slice in SQL so even 64 large rows cannot materialize more than the read's byte budget.
  const rows = yield* sql`SELECT max(byte_offset, ${offset}) AS byte_offset,
    substr(data, max(0, ${offset} - byte_offset) + 1,
      min(length(data), ${offset + length} - byte_offset) - max(0, ${offset} - byte_offset)) AS data
    FROM drive_metadata_chunks
    WHERE oid = ${oid} AND format_version = ${FORMAT_VERSION}
      AND byte_offset >= ${first.byte_offset} AND byte_offset < ${offset + length}
    ORDER BY byte_offset LIMIT ${MAX_READ_ROWS}`;
  return yield* decodeChunks(rows);
});
