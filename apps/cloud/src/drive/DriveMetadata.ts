import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import type { Oid } from "./git/gitObjects.ts";
import * as Storage from "./metadata/storage.ts";

export const limits = {
  chunkBytes: Storage.MAX_CHUNK_BYTES,
  batchBytes: Storage.MAX_BATCH_BYTES,
  batchChunks: Storage.MAX_BATCH_CHUNKS,
  checkpointBytes: Storage.MAX_CHECKPOINT_BYTES,
  readRows: Storage.MAX_READ_ROWS,
} as const;

const Count = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const ObjectKind = Schema.Literals(["commit", "tree", "blob", "tag"]);
const ObjectId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const LocatorName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
const Location = Schema.Struct({
  oid: ObjectId,
  pack: LocatorName,
  offset: Count,
  length: Count,
  type: ObjectKind,
  size: Count,
  storageDriveId: Schema.optionalKey(LocatorName),
});

export const MetadataSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pack"), location: Location }),
  Schema.Struct({
    kind: Schema.Literal("remote"),
    repository: LocatorName,
    size: Schema.NullOr(Count),
  }),
]);
export type MetadataSource = typeof MetadataSource.Type;

const expectedSize = (source: MetadataSource) =>
  source.kind === "pack" ? source.location.size : source.size;

export const MetadataState = Schema.Struct({
  oid: ObjectId,
  formatVersion: Schema.Literal(Storage.FORMAT_VERSION),
  source: MetadataSource,
  revision: Count,
  bytesWritten: Count,
  /** Opaque caller-owned state. The caller versions its contents; the store never parses them. */
  checkpoint: Schema.NullOr(Schema.String),
  complete: Schema.Boolean,
});
export type MetadataState = typeof MetadataState.Type;

export class MetadataInputError extends Schema.TaggedError<MetadataInputError>()(
  "MetadataInputError",
  {
    operation: Schema.Literals(["begin", "status", "advance", "bytes"]),
    reason: Schema.Literals([
      "schema",
      "source",
      "batch",
      "chunk",
      "checkpoint",
      "progress",
      "size",
      "range",
    ]),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return "Invalid metadata store operation.";
  }
}

export class MetadataStateError extends Schema.TaggedError<MetadataStateError>()(
  "MetadataStateError",
  {
    oid: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return "Stored metadata could not be decoded.";
  }
}

export class MetadataMissingError extends Schema.TaggedError<MetadataMissingError>()(
  "MetadataMissingError",
  {
    oid: Schema.String,
  },
) {
  override get message() {
    return "Metadata hydration has not begun.";
  }
}

export interface MetadataAdvance {
  readonly oid: Oid;
  readonly expectedRevision: number;
  readonly expectedBytesWritten: number;
  readonly chunks: ReadonlyArray<Uint8Array>;
  readonly checkpoint: string | null;
  readonly complete: boolean;
}
export type MetadataAdvanceResult = {
  readonly _tag: "advanced" | "conflict";
  readonly state: MetadataState;
};
export interface MetadataBytes {
  readonly _tag: "more" | "pending" | "complete";
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly nextOffset: number;
}
type Failure = SqlError | MetadataInputError | MetadataStateError;

export class DriveMetadata extends Context.Service<
  DriveMetadata,
  {
    readonly begin: (oid: Oid, source: MetadataSource) => Effect.Effect<MetadataState, Failure>;
    readonly status: (oid: Oid) => Effect.Effect<MetadataState | null, Failure>;
    readonly advance: (
      input: MetadataAdvance,
    ) => Effect.Effect<MetadataAdvanceResult, Failure | MetadataMissingError>;
    readonly bytes: (
      oid: Oid,
      offset: number,
      maxBytes: number,
    ) => Effect.Effect<MetadataBytes, Failure | MetadataMissingError>;
  }
>()("@signalbox/cloud/drive/DriveMetadata") {}

export const createTables = Storage.createTables;

const SourceJson = Schema.fromJsonString(MetadataSource);
const StateRow = Schema.Struct({
  source_json: SourceJson,
  revision: Count,
  bytes_written: Count,
  checkpoint: Schema.NullOr(Schema.String),
  complete: Schema.Literals([0, 1]),
});
const AdvanceHeader = Schema.Struct({
  oid: ObjectId,
  expectedRevision: Count,
  expectedBytesWritten: Count,
  checkpoint: Schema.NullOr(Schema.String),
  complete: Schema.Boolean,
  chunks: Schema.Array(Schema.Uint8Array).check(Schema.isMaxLength(limits.batchChunks)),
});
const encoder = new TextEncoder();
const decodeOid = Schema.decodeUnknownEffect(ObjectId);
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(StateRow));
const decodeSource = Schema.decodeUnknownEffect(MetadataSource);
const encodeSource = Schema.encodeEffect(SourceJson);
const decodeAdvance = Schema.decodeUnknownEffect(AdvanceHeader);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const validateOid = (oid: Oid, operation: MetadataInputError["operation"]) =>
    decodeOid(oid).pipe(
      Effect.mapError((cause) => new MetadataInputError({ operation, reason: "schema", cause })),
    );
  const load = Effect.fn("DriveMetadata.load")(function* (oid: Oid) {
    const rows = yield* sql`SELECT source_json, revision, bytes_written, checkpoint, complete
      FROM drive_metadata_objects WHERE oid = ${oid} AND format_version = ${Storage.FORMAT_VERSION}`;
    const row = (yield* decodeRows(rows).pipe(
      Effect.mapError((cause) => new MetadataStateError({ oid, cause })),
    ))[0];
    if (row === undefined) return null;
    return {
      oid,
      formatVersion: Storage.FORMAT_VERSION,
      source: row.source_json,
      revision: row.revision,
      bytesWritten: row.bytes_written,
      checkpoint: row.checkpoint,
      complete: row.complete === 1,
    } satisfies MetadataState;
  });
  const status = Effect.fn("DriveMetadata.status")(function* (oid: Oid) {
    yield* validateOid(oid, "status");
    return yield* load(oid);
  });
  const begin = Effect.fn("DriveMetadata.begin")(function* (oid: Oid, source: MetadataSource) {
    yield* validateOid(oid, "begin");
    const checked = yield* decodeSource(source).pipe(
      Effect.mapError(
        (cause) => new MetadataInputError({ operation: "begin", reason: "schema", cause }),
      ),
    );
    if (checked.kind === "pack" && checked.location.oid !== oid) {
      return yield* new MetadataInputError({ operation: "begin", reason: "source" });
    }
    const encoded = yield* encodeSource(checked).pipe(
      Effect.mapError(
        (cause) => new MetadataInputError({ operation: "begin", reason: "schema", cause }),
      ),
    );
    return yield* Effect.gen(function* () {
      yield* sql`INSERT INTO drive_metadata_objects (oid, format_version, source_json)
        VALUES (${oid}, ${Storage.FORMAT_VERSION}, ${encoded}) ON CONFLICT (oid, format_version) DO NOTHING`;
      const state = yield* load(oid);
      if (state === null) return yield* Effect.die(new MetadataMissingError({ oid }));
      return state;
    }).pipe(sql.withTransaction);
  });
  const advance = Effect.fn("DriveMetadata.advance")(function* (input: MetadataAdvance) {
    if (!Array.isArray(input.chunks) || input.chunks.length > limits.batchChunks) {
      return yield* new MetadataInputError({ operation: "advance", reason: "batch" });
    }
    yield* decodeAdvance(input).pipe(
      Effect.mapError(
        (cause) => new MetadataInputError({ operation: "advance", reason: "schema", cause }),
      ),
    );
    let added = 0;
    for (const chunk of input.chunks) {
      if (chunk.length === 0 || chunk.length > limits.chunkBytes) {
        return yield* new MetadataInputError({ operation: "advance", reason: "chunk" });
      }
      added += chunk.length;
    }
    if (added > limits.batchBytes)
      return yield* new MetadataInputError({ operation: "advance", reason: "batch" });
    if (
      input.checkpoint !== null &&
      (input.checkpoint.length > limits.checkpointBytes ||
        encoder.encode(input.checkpoint).length > limits.checkpointBytes)
    ) {
      return yield* new MetadataInputError({ operation: "advance", reason: "checkpoint" });
    }
    // Copy only the bounded batch before yielding, so caller mutations cannot change committed bytes.
    const chunks = input.chunks.map((chunk) => new Uint8Array(chunk));
    return yield* Effect.gen(function* () {
      const current = yield* load(input.oid);
      if (current === null) return yield* new MetadataMissingError({ oid: input.oid });
      if (
        current.revision !== input.expectedRevision ||
        current.bytesWritten !== input.expectedBytesWritten ||
        current.complete
      ) {
        return { _tag: "conflict", state: current } as const;
      }
      const bytesWritten = current.bytesWritten + added;
      const size = expectedSize(current.source);
      if (
        !Number.isSafeInteger(bytesWritten) ||
        (size !== null && (bytesWritten > size || (input.complete && bytesWritten !== size)))
      ) {
        return yield* new MetadataInputError({ operation: "advance", reason: "size" });
      }
      if (
        current.revision === Number.MAX_SAFE_INTEGER ||
        (added === 0 && input.checkpoint === current.checkpoint && !input.complete)
      ) {
        return yield* new MetadataInputError({ operation: "advance", reason: "progress" });
      }
      let offset = current.bytesWritten;
      for (const chunk of chunks) {
        yield* sql`INSERT INTO drive_metadata_chunks (oid, format_version, byte_offset, data)
          VALUES (${input.oid}, ${Storage.FORMAT_VERSION}, ${offset}, ${chunk})`;
        offset += chunk.length;
      }
      yield* sql`UPDATE drive_metadata_objects SET revision = ${current.revision + 1},
        bytes_written = ${bytesWritten}, checkpoint = ${input.checkpoint}, complete = ${input.complete ? 1 : 0}
        WHERE oid = ${input.oid} AND format_version = ${Storage.FORMAT_VERSION}`;
      return {
        _tag: "advanced",
        state: {
          ...current,
          revision: current.revision + 1,
          bytesWritten,
          checkpoint: input.checkpoint,
          complete: input.complete,
        },
      } as const;
    }).pipe(sql.withTransaction);
  });
  const bytes = Effect.fn("DriveMetadata.bytes")(function* (
    oid: Oid,
    offset: number,
    maxBytes: number,
  ) {
    yield* validateOid(oid, "bytes");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > limits.chunkBytes
    ) {
      return yield* new MetadataInputError({ operation: "bytes", reason: "range" });
    }
    return yield* Effect.gen(function* () {
      const state = yield* load(oid);
      if (state === null) return yield* new MetadataMissingError({ oid });
      const size = state.complete ? state.bytesWritten : expectedSize(state.source);
      if (size !== null && offset > size)
        return yield* new MetadataInputError({ operation: "bytes", reason: "range" });
      const length = Math.min(maxBytes, Math.max(0, state.bytesWritten - offset));
      const rows =
        length === 0
          ? []
          : yield* Storage.readChunks(oid, offset, length).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
              Effect.catchTags({
                SchemaError: (cause) => Effect.fail(new MetadataStateError({ oid, cause })),
              }),
            );
      const output = new Uint8Array(length);
      let written = 0;
      let gap = false;
      for (const row of rows) {
        if (row.byte_offset !== offset + written || row.data.length === 0) {
          gap = true;
          break;
        }
        output.set(row.data, written);
        written += row.data.length;
      }
      if (written < length && rows.length < limits.readRows) gap = true;
      const nextOffset = offset + written;
      return {
        _tag: gap
          ? "pending"
          : state.complete && nextOffset === state.bytesWritten
            ? "complete"
            : written > 0 && nextOffset < state.bytesWritten
              ? "more"
              : "pending",
        bytes: output.slice(0, written),
        nextOffset,
      } satisfies MetadataBytes;
    }).pipe(sql.withTransaction);
  });
  return DriveMetadata.of({ begin, status, advance, bytes });
});

export const layer = Layer.effect(DriveMetadata, make);
