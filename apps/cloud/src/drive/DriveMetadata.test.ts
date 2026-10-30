import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as DriveMetadata from "./DriveMetadata.ts";
import type { ObjectLocation } from "./DriveStore.ts";

const oid = "0123456789abcdef0123456789abcdef01234567";
const source = (size: number, storageDriveId = "original-drive") =>
  ({
    kind: "pack",
    location: {
      oid,
      pack: "original-pack",
      offset: 42,
      length: 100,
      type: "tree",
      size,
      storageDriveId,
    },
  }) satisfies DriveMetadata.MetadataSource;
const step = (
  overrides: Partial<DriveMetadata.MetadataAdvance> = {},
): DriveMetadata.MetadataAdvance => ({
  oid,
  expectedRevision: 0,
  expectedBytesWritten: 0,
  chunks: [],
  checkpoint: null,
  complete: false,
  ...overrides,
});
const withStore = <A, E>(
  test: Effect.Effect<A, E, DriveMetadata.DriveMetadata | SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    yield* DriveMetadata.createTables;
    return yield* test;
  }).pipe(
    Effect.provide(
      DriveMetadata.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );

describe("DriveMetadata", () => {
  it.effect(
    "freezes the first source including imported storageDriveId and detaches caller values",
    () =>
      withStore(
        Effect.gen(function* () {
          const store = yield* DriveMetadata.DriveMetadata;
          expect(yield* store.status(oid)).toBeNull();
          const original = source(12);
          const location: ObjectLocation = original.location;
          const first = yield* store.begin(oid, { kind: "pack", location });
          original.location.storageDriveId = "mutated-after-begin";
          expect(first).toMatchObject({
            formatVersion: 1,
            revision: 0,
            bytesWritten: 0,
            checkpoint: null,
            complete: false,
          });
          const retry = yield* store.begin(oid, {
            ...source(19, "another-drive"),
            location: { ...source(19).location, pack: "new-pack", storageDriveId: "another-drive" },
          });
          expect(retry).toEqual(first);
          expect((yield* store.status(oid))?.source).toEqual(source(12));
        }),
      ),
  );

  it.effect(
    "recreates a service on the same database and resumes an opaque zero-output checkpoint",
    () =>
      withStore(
        Effect.gen(function* () {
          const store = yield* DriveMetadata.DriveMetadata;
          yield* store.begin(oid, source(3));
          const header = yield* store.advance(step({ checkpoint: "v1:opaque header state" }));
          expect(header.state).toMatchObject({
            revision: 1,
            bytesWritten: 0,
            checkpoint: "v1:opaque header state",
          });
          const resumed = yield* Effect.gen(function* () {
            const fresh = yield* DriveMetadata.DriveMetadata;
            expect(fresh).not.toBe(store);
            expect(yield* fresh.status(oid)).toEqual(header.state);
            return yield* fresh.advance(
              step({
                expectedRevision: 1,
                chunks: [new Uint8Array([1, 2, 3])],
                checkpoint: "v1:finished",
                complete: true,
              }),
            );
          }).pipe(Effect.provide(DriveMetadata.layer, { local: true }));
          expect(resumed.state).toMatchObject({
            revision: 2,
            bytesWritten: 3,
            checkpoint: "v1:finished",
            complete: true,
          });
          expect(yield* store.bytes(oid, 0, 64)).toEqual({
            _tag: "complete",
            bytes: new Uint8Array([1, 2, 3]),
            nextOffset: 3,
          });
        }),
      ),
  );

  it.effect(
    "serializes competing CAS writers and returns current progress for duplicate deliveries",
    () =>
      withStore(
        Effect.gen(function* () {
          const store = yield* DriveMetadata.DriveMetadata;
          yield* store.begin(oid, source(2));
          const request = step({ chunks: [new Uint8Array([4])], checkpoint: "v1:a" });
          const attempts = yield* Effect.all(
            [store.advance(request), store.advance({ ...request, chunks: [new Uint8Array([9])] })],
            { concurrency: 2 },
          );
          expect(attempts.map((result) => result._tag).sort()).toEqual(["advanced", "conflict"]);
          const current = yield* store.status(oid);
          expect(attempts[0]?.state).toEqual(current);
          expect(attempts[1]?.state).toEqual(current);
          expect((yield* store.advance(request))._tag).toBe("conflict");
          expect(
            yield* store.advance(
              step({ expectedRevision: 1, expectedBytesWritten: 0, checkpoint: "bad offset" }),
            ),
          ).toEqual({ _tag: "conflict", state: current });
          const done = yield* store.advance(
            step({
              expectedRevision: 1,
              expectedBytesWritten: 1,
              chunks: [new Uint8Array([5])],
              complete: true,
            }),
          );
          expect((yield* store.advance(request)).state).toEqual(done.state);
          expect(
            yield* store.advance(
              step({ expectedRevision: 2, expectedBytesWritten: 2, checkpoint: "rewind" }),
            ),
          ).toEqual({ _tag: "conflict", state: done.state });
          expect((yield* store.bytes(oid, 0, 2)).bytes.length).toBe(2);
        }),
      ),
  );

  it.effect("rejects a bad later chunk without saving earlier bytes or its checkpoint", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DriveMetadata.DriveMetadata;
        const initial = yield* store.begin(oid, source(8));
        const error = yield* store
          .advance(
            step({ chunks: [new Uint8Array([1]), new Uint8Array()], checkpoint: "bad batch" }),
          )
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "MetadataInputError", reason: "chunk" });
        expect(yield* store.status(oid)).toEqual(initial);
        expect(yield* store.bytes(oid, 0, 8)).toEqual({
          _tag: "pending",
          bytes: new Uint8Array(),
          nextOffset: 0,
        });
      }),
    ),
  );

  it.effect("rolls back SQL failure after an earlier chunk insert in the same transaction", () =>
    withStore(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* DriveMetadata.DriveMetadata;
        const initial = yield* store.begin(oid, source(2));
        yield* sql`CREATE TRIGGER fail_second_chunk BEFORE INSERT ON drive_metadata_chunks
      WHEN NEW.byte_offset > 0 BEGIN SELECT RAISE(ABORT, 'test failure'); END`;
        const error = yield* store
          .advance(
            step({
              chunks: [new Uint8Array([1]), new Uint8Array([2])],
              checkpoint: "v1:should rollback",
              complete: true,
            }),
          )
          .pipe(Effect.flip);
        expect(error._tag).toBe("SqlError");
        expect(yield* store.status(oid)).toEqual(initial);
        expect((yield* store.bytes(oid, 0, 2)).bytes).toEqual(new Uint8Array());
        yield* sql`DROP TRIGGER fail_second_chunk`;
        expect(
          (yield* store.advance(step({ chunks: [new Uint8Array([3, 4])], complete: true })))._tag,
        ).toBe("advanced");
      }),
    ),
  );

  it.effect("reports partial and future ranges as pending until final bytes are complete", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DriveMetadata.DriveMetadata;
        yield* store.begin(oid, source(5));
        yield* store.advance(
          step({ chunks: [new Uint8Array([10, 11, 12])], checkpoint: "v1:partial" }),
        );
        expect(yield* store.bytes(oid, 1, 4)).toEqual({
          _tag: "pending",
          bytes: new Uint8Array([11, 12]),
          nextOffset: 3,
        });
        expect(yield* store.bytes(oid, 4, 1)).toEqual({
          _tag: "pending",
          bytes: new Uint8Array(),
          nextOffset: 4,
        });
        expect(yield* store.bytes(oid, 0, 1)).toEqual({
          _tag: "more",
          bytes: new Uint8Array([10]),
          nextOffset: 1,
        });
        yield* store.advance(
          step({
            expectedRevision: 1,
            expectedBytesWritten: 3,
            chunks: [new Uint8Array([13, 14])],
            complete: true,
          }),
        );
        expect(yield* store.bytes(oid, 3, 4)).toEqual({
          _tag: "complete",
          bytes: new Uint8Array([13, 14]),
          nextOffset: 5,
        });
        expect(yield* store.bytes(oid, 5, 1)).toEqual({
          _tag: "complete",
          bytes: new Uint8Array(),
          nextOffset: 5,
        });
      }),
    ),
  );

  it.effect("makes resumable progress through one-byte chunks within the row quota", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DriveMetadata.DriveMetadata;
        const count = DriveMetadata.limits.readRows * 2 + 1;
        yield* store.begin(oid, source(count));
        let revision = 0;
        for (let offset = 0; offset < count; offset += DriveMetadata.limits.batchChunks) {
          const length = Math.min(count - offset, DriveMetadata.limits.batchChunks);
          yield* store.advance(
            step({
              expectedRevision: revision++,
              expectedBytesWritten: offset,
              chunks: Array.from({ length }, (_, index) => new Uint8Array([offset + index])),
              complete: offset + length === count,
            }),
          );
        }
        let offset = 0;
        const collected: number[] = [];
        while (offset < count) {
          const page = yield* store.bytes(oid, offset, 65536);
          expect(page.bytes.length).toBe(Math.min(DriveMetadata.limits.readRows, count - offset));
          expect(page._tag).toBe(page.nextOffset === count ? "complete" : "more");
          expect(page.nextOffset).toBeGreaterThan(offset);
          collected.push(...page.bytes);
          offset = page.nextOffset;
        }
        expect(collected).toEqual(Array.from({ length: count }, (_, index) => index));
      }),
    ),
  );

  it.effect("reads arbitrary offsets across uneven and maximum-sized chunk boundaries", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DriveMetadata.DriveMetadata;
        const data = Uint8Array.from({ length: 65536 * 3 + 17 }, (_, index) => (index * 31) % 251);
        yield* store.begin(oid, source(data.length));
        const boundaries = [0, 1, 6, 65542, 131078, 196614, data.length];
        yield* store.advance(
          step({
            chunks: boundaries.slice(1).map((end, index) => data.slice(boundaries[index], end)),
            complete: true,
          }),
        );
        const offsets = [
          0,
          1,
          5,
          6,
          65535,
          65541,
          65542,
          131077,
          131078,
          data.length - 1,
          data.length,
        ];
        for (let index = 0; index < 40; index++) offsets.push((index * 7919) % data.length);
        for (const offset of offsets) {
          const page = yield* store.bytes(oid, offset, 65536);
          expect(page.bytes).toEqual(data.slice(offset, offset + 65536));
          expect(page.nextOffset).toBe(Math.min(offset + 65536, data.length));
        }
      }),
    ),
  );

  it.effect("refuses oversized batches, chunks, and UTF-8 checkpoints without mutations", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DriveMetadata.DriveMetadata;
        const initial = yield* store.begin(oid, source(1000000));
        const invalid = [
          step({ chunks: [new Uint8Array(65537)] }),
          step({
            chunks: Array.from(
              { length: DriveMetadata.limits.batchChunks + 1 },
              () => new Uint8Array([1]),
            ),
          }),
          step({ chunks: Array.from({ length: 5 }, () => new Uint8Array(65536)) }),
          step({ checkpoint: "x".repeat(DriveMetadata.limits.checkpointBytes + 1) }),
          step({ checkpoint: "é".repeat(DriveMetadata.limits.checkpointBytes / 2 + 1) }),
        ];
        for (const request of invalid) {
          expect((yield* store.advance(request).pipe(Effect.flip))._tag).toBe("MetadataInputError");
          expect(yield* store.status(oid)).toEqual(initial);
          expect((yield* store.bytes(oid, 0, 65536)).bytes.length).toBe(0);
        }
        const accepted = yield* store.advance(
          step({
            chunks: Array.from({ length: 4 }, () => new Uint8Array(65536)),
            checkpoint: "é".repeat(DriveMetadata.limits.checkpointBytes / 2),
          }),
        );
        expect(accepted.state.bytesWritten).toBe(DriveMetadata.limits.batchBytes);
      }),
    ),
  );

  it.effect("requires the exact final size and supports zero-size completion", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DriveMetadata.DriveMetadata;
        const initial = yield* store.begin(oid, source(3));
        for (const request of [
          step({ complete: true }),
          step({ chunks: [new Uint8Array(4)] }),
          step({ chunks: [new Uint8Array(2)], complete: true }),
        ]) {
          expect(yield* store.advance(request).pipe(Effect.flip)).toMatchObject({
            _tag: "MetadataInputError",
            reason: "size",
          });
          expect(yield* store.status(oid)).toEqual(initial);
        }
        yield* store.advance(step({ chunks: [new Uint8Array(3)] }));
        expect((yield* store.bytes(oid, 0, 3))._tag).toBe("pending");
        expect(
          (yield* store.advance(
            step({ expectedRevision: 1, expectedBytesWritten: 3, complete: true }),
          )).state.complete,
        ).toBe(true);
        const emptyOid = "a".repeat(40);
        yield* store.begin(emptyOid, {
          ...source(0),
          location: { ...source(0).location, oid: emptyOid },
        });
        yield* store.advance(step({ oid: emptyOid, complete: true }));
        expect(yield* store.bytes(emptyOid, 0, 1)).toEqual({
          _tag: "complete",
          bytes: new Uint8Array(),
          nextOffset: 0,
        });
      }),
    ),
  );

  it.effect("reports missing chunks without padding or skipping to later rows", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DriveMetadata.DriveMetadata;
        const sql = yield* SqlClient.SqlClient;
        yield* store.begin(oid, source(4));
        yield* store.advance(
          step({
            chunks: [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3, 4])],
            complete: true,
          }),
        );
        yield* sql`DELETE FROM drive_metadata_chunks WHERE byte_offset = 1`;
        expect(yield* store.bytes(oid, 0, 4)).toEqual({
          _tag: "pending",
          bytes: new Uint8Array([1]),
          nextOffset: 1,
        });
        expect(yield* store.bytes(oid, 1, 2)).toEqual({
          _tag: "pending",
          bytes: new Uint8Array(),
          nextOffset: 1,
        });
        expect(yield* store.bytes(oid, 2, 2)).toEqual({
          _tag: "complete",
          bytes: new Uint8Array([3, 4]),
          nextOffset: 4,
        });
      }),
    ),
  );

  it.effect("keeps schema causes structured and validates progress and range bounds", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DriveMetadata.DriveMetadata;
        expect(yield* store.begin("invalid", source(2)).pipe(Effect.flip)).toMatchObject({
          _tag: "MetadataInputError",
          cause: { _tag: "SchemaError" },
        });
        expect(yield* store.bytes(oid, 0, 1).pipe(Effect.flip)).toMatchObject({
          _tag: "MetadataMissingError",
        });
        yield* store.begin(oid, source(2));
        expect(yield* store.advance(step()).pipe(Effect.flip)).toMatchObject({
          _tag: "MetadataInputError",
          reason: "progress",
        });
        for (const [offset, maxBytes] of [
          [-1, 1],
          [0.5, 1],
          [0, 0],
          [0, 65537],
          [3, 1],
          [Number.MAX_SAFE_INTEGER + 1, 1],
        ]) {
          expect((yield* store.bytes(oid, offset!, maxBytes!).pipe(Effect.flip))._tag).toBe(
            "MetadataInputError",
          );
        }
        expect(
          (yield* store
            .advance(step({ expectedRevision: -1, checkpoint: "bad revision" }))
            .pipe(Effect.flip))._tag,
        ).toBe("MetadataInputError");
      }),
    ),
  );

  it.effect("continues beyond legacy object-size gates without an eligibility cap", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DriveMetadata.DriveMetadata;
        const size = 17 * 1024 * 1024;
        yield* store.begin(oid, source(size));
        let revision = 0;
        for (let offset = 0; offset < size; offset += DriveMetadata.limits.batchBytes) {
          const chunks = Array.from({ length: 4 }, () =>
            new Uint8Array(DriveMetadata.limits.chunkBytes).fill(revision % 251),
          );
          yield* store.advance(
            step({
              expectedRevision: revision++,
              expectedBytesWritten: offset,
              chunks,
              complete: offset + DriveMetadata.limits.batchBytes === size,
            }),
          );
        }
        expect(yield* store.status(oid)).toMatchObject({ bytesWritten: size, complete: true });
        expect((yield* store.bytes(oid, size - 1, 65536)).bytes).toEqual(
          new Uint8Array([(revision - 1) % 251]),
        );
      }),
    ),
  );

  it.effect("freezes remote descriptors and completes unknown sizes at the actual byte count", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DriveMetadata.DriveMetadata;
        const remote: DriveMetadata.MetadataSource = {
          kind: "remote",
          repository: "owner/repository",
          size: null,
        };
        const initial = yield* store.begin(oid, remote);
        expect(yield* store.begin(oid, source(100))).toEqual(initial);
        expect(
          yield* store.begin(oid, { kind: "remote", repository: "different/repository", size: 2 }),
        ).toEqual(initial);
        expect(yield* store.bytes(oid, 100, 1)).toEqual({
          _tag: "pending",
          bytes: new Uint8Array(),
          nextOffset: 100,
        });
        yield* store.advance(step({ checkpoint: "v1:range headers" }));
        yield* store.advance(step({ expectedRevision: 1, chunks: [new Uint8Array([7, 8, 9])] }));
        expect(yield* store.bytes(oid, 0, 65536)).toEqual({
          _tag: "pending",
          bytes: new Uint8Array([7, 8, 9]),
          nextOffset: 3,
        });
        const final = yield* store.advance(
          step({ expectedRevision: 2, expectedBytesWritten: 3, complete: true }),
        );
        expect(final.state).toMatchObject({ source: remote, bytesWritten: 3, complete: true });
        expect(yield* store.bytes(oid, 0, 65536)).toEqual({
          _tag: "complete",
          bytes: new Uint8Array([7, 8, 9]),
          nextOffset: 3,
        });
        expect((yield* store.bytes(oid, 4, 1).pipe(Effect.flip))._tag).toBe("MetadataInputError");
      }),
    ),
  );

  it.effect("enforces known remote sizes and preserves a structured stored-schema cause", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DriveMetadata.DriveMetadata;
        const sql = yield* SqlClient.SqlClient;
        const initial = yield* store.begin(oid, {
          kind: "remote",
          repository: "owner/repository",
          size: 2,
        });
        expect(
          yield* store
            .advance(step({ chunks: [new Uint8Array([1])], complete: true }))
            .pipe(Effect.flip),
        ).toMatchObject({ _tag: "MetadataInputError", reason: "size" });
        expect(yield* store.status(oid)).toEqual(initial);
        yield* store.advance(step({ chunks: [new Uint8Array([1, 2])], complete: true }));
        yield* sql`UPDATE drive_metadata_objects SET source_json = 'invalid JSON' WHERE oid = ${oid}`;
        expect(yield* store.status(oid).pipe(Effect.flip)).toMatchObject({
          _tag: "MetadataStateError",
          cause: { _tag: "SchemaError" },
        });
      }),
    ),
  );
});
