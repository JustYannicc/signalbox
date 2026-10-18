// @effect-diagnostics nodeBuiltinImport:off - fixtures hash and compress owned bytes and reopen an isolated SQLite file.
import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import * as DriveDirectory from "./DriveDirectory.ts";
import * as DriveHydration from "./DriveHydration.ts";
import * as DriveMetadata from "./DriveMetadata.ts";
import * as DrivePacks from "./DrivePacks.ts";
import type { ObjectLocation } from "./DriveStore.ts";
import { makeMemoryDrives } from "./driveTesting.ts";

const DRIVE = "logical-owner";
const LIMIT = 64 * 1024;
const id = (type: ObjectLocation["type"], data: Uint8Array) =>
  NodeCrypto.createHash("sha1").update(`${type} ${data.length}\0`).update(data).digest("hex");
const varint = (value: number) => {
  const bytes: Array<number> = [];
  do {
    const byte = value % 128;
    value = Math.floor(value / 128);
    bytes.push(byte | (value === 0 ? 0 : 128));
  } while (value !== 0);
  return Buffer.from(bytes);
};
const header = (type: number, size: number) => {
  const bytes = [(type << 4) | (size & 15)];
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes[bytes.length - 1]! |= 128;
    bytes.push(size % 128);
    size = Math.floor(size / 128);
  }
  return Buffer.from(bytes);
};
const distance = (value: number) => {
  const bytes = [value & 127];
  while ((value = Math.floor(value / 128)) > 0) bytes.unshift(128 | (--value & 127));
  return Buffer.from(bytes);
};
const copy = (offset: number, length: number) => {
  let opcode = 128;
  const bytes: Array<number> = [];
  for (let index = 0; index < 7; index++) {
    const byte =
      Math.floor((index < 4 ? offset : length) / 2 ** ((index < 4 ? index : index - 4) * 8)) & 255;
    if (byte !== 0) {
      opcode |= 1 << index;
      bytes.push(byte);
    }
  }
  return Buffer.from([opcode, ...bytes]);
};
const packed = (
  content: Uint8Array,
  options: {
    type?: ObjectLocation["type"];
    payload?: Uint8Array;
    code?: number;
    base?: Uint8Array;
    offset?: number;
  } = {},
) => {
  const type = options.type ?? "blob";
  const bytes = Buffer.concat([
    header(options.code ?? (type === "tree" ? 2 : 3), options.payload?.length ?? content.length),
    options.base ?? Buffer.alloc(0),
    NodeZlib.deflateSync(options.payload ?? content, { level: 9 }),
  ]);
  const location: ObjectLocation = {
    oid: id(type, content),
    pack: "fixture",
    offset: options.offset ?? 12,
    length: bytes.length,
    type,
    size: content.length,
    storageDriveId: "imported-storage",
  };
  return { bytes, location };
};
const withStore = <A, E>(effect: Effect.Effect<A, E, DriveMetadata.DriveMetadata>) =>
  Effect.gen(function* () {
    yield* DriveMetadata.createTables;
    return yield* effect;
  }).pipe(
    Effect.provide(
      DriveMetadata.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  );

const rig = Effect.fn("test.hydrationRig")(function* (
  objects: ReadonlyArray<ReturnType<typeof packed>>,
  remote?: DriveHydration.HydrationRemote,
) {
  const store = yield* DriveMetadata.DriveMetadata;
  const backing = DriveDirectory.handleFor(makeMemoryDrives().apiFor(DRIVE));
  const calls: Array<{ driveId: string; offset: number; length: number }> = [];
  const writes: Array<DriveMetadata.MetadataAdvance> = [];
  const locations = new Map(objects.map((object) => [object.location.oid, object.location]));
  let beforeRange: (() => Effect.Effect<void>) | undefined;
  let remoteRepository = "original/repository";
  let promisedSize: number | null = null;
  const wire = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) => new DriveDirectory.DriveObjectError({ operation, cause })),
    );
  const handle: DriveDirectory.DriveHandle = {
    ...backing,
    locate: (oids) => Effect.succeed(oids.flatMap((oid) => locations.get(oid) ?? [])),
    locateAt: (pack, offset) =>
      Effect.succeed(
        objects.find((object) => object.location.pack === pack && object.location.offset === offset)
          ?.location ?? null,
      ),
    promised: (oids) => Effect.succeed(oids.map((oid) => ({ oid, size: promisedSize }))),
    remote: () =>
      Effect.succeed({ provider: "github", repository: remoteRepository, defaultBranch: "main" }),
    metadataBegin: (oid, source) => wire("metadataBegin", store.begin(oid, source)),
    metadataStatus: (oid) => wire("metadataStatus", store.status(oid)),
    metadataAdvance: (input) => {
      writes.push(input);
      expect(input.chunks.reduce((total, chunk) => total + chunk.length, 0)).toBeLessThanOrEqual(
        LIMIT,
      );
      expect(input.checkpoint?.length ?? 0).toBeLessThanOrEqual(256 * 1024);
      return wire("metadataAdvance", store.advance(input));
    },
    metadataBytes: (oid, offset, length) => wire("metadataBytes", store.bytes(oid, offset, length)),
  };
  const packs = DrivePacks.DrivePacks.of({
    put: () => Effect.void,
    get: () => Effect.succeed(null),
    stream: () => Effect.die("Unused test adapter method."),
    range: (driveId, _pack, offset, length) =>
      Effect.gen(function* () {
        calls.push({ driveId, offset, length });
        if (beforeRange !== undefined) yield* beforeRange();
        const object = objects.find(
          (candidate) =>
            offset >= candidate.location.offset &&
            offset < candidate.location.offset + candidate.location.length,
        );
        if (object === undefined)
          return yield* new DrivePacks.DrivePackError({
            operation: "range",
            cause: "Missing fixture range.",
          });
        expect(driveId).toBe("imported-storage");
        const start = offset - object.location.offset;
        return object.bytes.subarray(start, start + length);
      }),
  });
  const fresh = () =>
    DriveHydration.makeDriveHydration(DRIVE, remote).pipe(
      Effect.provideService(DriveDirectory.DriveDirectory, {
        forDrive: (driveId) => {
          expect(driveId).toBe(DRIVE);
          return handle;
        },
      }),
      Effect.provideService(DrivePacks.DrivePacks, packs),
    );
  const step = Effect.fn("test.hydrationStep")(function* (oid: string, known?: ObjectLocation) {
    calls.length = 0;
    const hydration = yield* fresh();
    const result = yield* hydration.step(oid, known);
    expect(calls.reduce((sum, call) => sum + call.length, 0)).toBeLessThanOrEqual(LIMIT);
    return result;
  });
  const finish = Effect.fn("test.hydrationFinish")(function* (oid: string, budget = 2000) {
    for (let count = 1; count <= budget; count++) {
      if ((yield* step(oid)).complete) return count;
    }
    throw new Error("Fixture exceeded its hydration step budget.");
  });
  return {
    store,
    handle,
    calls,
    writes,
    locations,
    fresh,
    step,
    finish,
    beforeRange: (effect: typeof beforeRange) => {
      beforeRange = effect;
    },
    remoteRepository: (value: string) => {
      remoteRepository = value;
    },
    promisedSize: (value: number | null) => {
      promisedSize = value;
    },
  };
});

const largeTree = () => {
  const entry = Buffer.concat([Buffer.from("100644 file-0000000\0"), Buffer.alloc(20, 0xab)]);
  const count = Math.ceil((11 * 1024 * 1024) / entry.length);
  const tree = Buffer.alloc(count * entry.length);
  for (let index = 0; index < count; index++) {
    entry.copy(tree, index * entry.length);
    tree.write(String(index).padStart(7, "0"), index * entry.length + 12, "ascii");
  }
  return tree;
};
const expectContent = Effect.fn("test.expectMetadataContent")(function* (
  store: DriveMetadata.DriveMetadata["Service"],
  oid: string,
  expected: Uint8Array,
) {
  let offset = 0;
  do {
    const result = yield* store.bytes(oid, offset, LIMIT);
    expect(Buffer.from(result.bytes).equals(expected.subarray(offset, result.nextOffset))).toBe(
      true,
    );
    expect(result.bytes.length).toBeLessThanOrEqual(LIMIT);
    if (result._tag === "complete") {
      expect(result.nextOffset).toBe(expected.length);
      return;
    }
    expect(result.nextOffset).toBeGreaterThan(offset);
    offset = result.nextOffset;
  } while (offset <= expected.length);
  throw new Error("Unexpected metadata read position.");
});

describe("restartable drive metadata hydration", () => {
  it.effect(
    "resumes inflate and Git hash state after disposing and reopening its SQLite scope",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "drive-hydration-"))),
          (directory) =>
            Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
        );
        const filename = NodePath.join(directory, "metadata.sqlite");
        const layerFor = () =>
          DriveMetadata.layer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));
        const content = Buffer.alloc(3 * LIMIT + 17, 0x63);
        const fixture = packed(content);
        const partial = yield* Effect.gen(function* () {
          yield* DriveMetadata.createTables;
          const first = yield* rig([fixture]);
          yield* first.step(fixture.location.oid);
          const partial = yield* first.step(fixture.location.oid);
          expect(partial.state.bytesWritten).toBe(LIMIT);
          return partial;
        }).pipe(Effect.provide(layerFor()), Effect.scoped);
        yield* Effect.gen(function* () {
          const resumed = yield* rig([fixture]);
          expect(yield* resumed.store.status(fixture.location.oid)).toEqual(partial.state);
          yield* resumed.finish(fixture.location.oid);
          yield* expectContent(resumed.store, fixture.location.oid, content);
        }).pipe(Effect.provide(layerFor()), Effect.scoped);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "hydrates a compressed Git tree above 10 MiB across cold instances and immutable checkpoints",
    () =>
      withStore(
        Effect.gen(function* () {
          const content = largeTree();
          expect(content.length).toBeGreaterThan(10 * 1024 * 1024);
          const fixture = packed(content, { type: "tree" });
          expect(fixture.bytes.length).toBeLessThan(content.length / 4);
          const test = yield* rig([fixture]);
          const first = yield* test.step(fixture.location.oid);
          expect(first.state.bytesWritten).toBe(0);
          const saved = first.state.checkpoint;
          const count = yield* test.finish(fixture.location.oid);
          expect(count).toBeGreaterThan(160);
          expect(first.state.checkpoint).toBe(saved);
          yield* expectContent(test.store, fixture.location.oid, content);
          const completed = yield* test.step(fixture.location.oid);
          expect(completed.state.revision).toBe(count + 1);
          expect(test.calls).toHaveLength(0);
        }),
      ),
  );

  it.effect.each(["ref", "ofs"] as const)(
    "hydrates a large %s delta through persisted arbitrary base ranges",
    (kind) =>
      withStore(
        Effect.gen(function* () {
          const base = Buffer.alloc(6 * 1024 * 1024, 0x61);
          base.fill(0x62, base.length / 2);
          const split = base.length / 2 + 13;
          const content = Buffer.concat([
            base.subarray(split),
            Buffer.from("!"),
            base.subarray(0, split),
          ]);
          const baseObject = packed(base);
          // Copy the second half, insert, then copy the first half. The result exceeds 6 MiB.
          const instructions = Buffer.concat([
            varint(base.length),
            varint(content.length),
            copy(split, base.length - split),
            Buffer.from([1, 0x21]),
            copy(0, split),
          ]);
          const offset = baseObject.location.offset + baseObject.bytes.length;
          const delta = packed(content, {
            payload: instructions,
            code: kind === "ref" ? 7 : 6,
            offset,
            base:
              kind === "ref"
                ? Buffer.from(baseObject.location.oid, "hex")
                : distance(offset - baseObject.location.offset),
          });
          const test = yield* rig([baseObject, delta]);
          const count = yield* test.finish(delta.location.oid);
          expect(count).toBeGreaterThan(190);
          yield* expectContent(test.store, baseObject.location.oid, base);
          yield* expectContent(test.store, delta.location.oid, content);
          const targetWrites = test.writes.filter(
            (write) => write.oid === delta.location.oid && write.chunks.length > 0,
          );
          expect(targetWrites.length).toBeGreaterThan(90);
        }),
      ),
  );

  it.effect(
    "continues insert instructions across the inflater's persisted instruction buffer",
    () =>
      withStore(
        Effect.gen(function* () {
          const base = packed(Buffer.from("base"));
          const content = Buffer.alloc(LIMIT + 513, 0x69);
          const inserts: Array<Buffer> = [];
          for (let offset = 0; offset < content.length; offset += 127) {
            const bytes = content.subarray(offset, offset + 127);
            inserts.push(Buffer.from([bytes.length]), bytes);
          }
          const instructions = Buffer.concat([varint(4), varint(content.length), ...inserts]);
          expect(instructions.length).toBeGreaterThan(LIMIT);
          const delta = packed(content, {
            code: 7,
            base: Buffer.from(base.location.oid, "hex"),
            payload: instructions,
            offset: base.location.offset + base.bytes.length,
          });
          const test = yield* rig([base, delta]);
          yield* test.finish(delta.location.oid);
          yield* expectContent(test.store, delta.location.oid, content);
          expect(
            test.writes.some(
              (write) =>
                write.oid === delta.location.oid && (write.checkpoint?.length ?? 0) > LIMIT,
            ),
          ).toBe(true);
        }),
      ),
  );

  it.effect(
    "freezes imported pack storage even when the locator and caller's location change",
    () =>
      withStore(
        Effect.gen(function* () {
          const content = Buffer.alloc(2 * LIMIT, 0x78);
          const fixture = packed(content);
          const test = yield* rig([fixture]);
          const original = { ...fixture.location };
          yield* test.step(original.oid, original);
          original.storageDriveId = "mutated-caller";
          test.locations.set(original.oid, {
            ...original,
            pack: "new-pack",
            storageDriveId: "wrong-storage",
          });
          yield* test.finish(original.oid);
          expect((yield* test.store.status(original.oid))?.source).toEqual({
            kind: "pack",
            location: fixture.location,
          });
          yield* expectContent(test.store, original.oid, content);
        }),
      ),
  );

  it.effect.each(["truncated", "checksum", "wrong-oid", "overlong-range"] as const)(
    "rejects %s without completing corrupt metadata",
    (fault) =>
      withStore(
        Effect.gen(function* () {
          const content = Buffer.alloc(1000, 0x78);
          const fixture = packed(content);
          if (fault === "truncated") {
            fixture.bytes = fixture.bytes.subarray(0, -1);
            fixture.location = { ...fixture.location, length: fixture.bytes.length };
          } else if (fault === "checksum") fixture.bytes[fixture.bytes.length - 1]! ^= 1;
          else if (fault === "wrong-oid")
            fixture.location = { ...fixture.location, oid: "0".repeat(40) };
          else {
            fixture.bytes = Buffer.concat([fixture.bytes, Buffer.from([0])]);
            fixture.location = { ...fixture.location, length: fixture.bytes.length };
          }
          const test = yield* rig([fixture]);
          yield* test.step(fixture.location.oid);
          const error = yield* Effect.flip(test.step(fixture.location.oid));
          expect(error._tag).toBe("DriveHydrationError");
          expect(error.reason).toBe(
            fault === "wrong-oid" ? "hash" : fault === "overlong-range" ? "range" : "inflate",
          );
          expect((yield* test.store.status(fixture.location.oid))?.complete).toBe(false);
          if (fault === "checksum" || fault === "truncated")
            expect(error.cause).toMatchObject({ _tag: "DriveInflateError" });
        }),
      ),
  );

  it.effect(
    "returns current state after competing output CAS without retrying or duplicating bytes",
    () =>
      withStore(
        Effect.gen(function* () {
          const fixture = packed(Buffer.alloc(3 * LIMIT, 0x61));
          const test = yield* rig([fixture]);
          yield* test.step(fixture.location.oid);
          const barrier = yield* Deferred.make<void>();
          let readers = 0;
          test.beforeRange(() =>
            Effect.gen(function* () {
              readers++;
              if (readers === 2) yield* Deferred.succeed(barrier, undefined);
              yield* Deferred.await(barrier);
            }),
          );
          const [left, right] = yield* Effect.all(
            [test.step(fixture.location.oid), test.step(fixture.location.oid)],
            { concurrency: 2 },
          );
          expect(readers).toBe(2);
          expect(left.state).toEqual(right.state);
          expect(left.state.bytesWritten).toBe(LIMIT);
          expect(left.state.revision).toBe(2);
          test.beforeRange(undefined);
          yield* test.finish(fixture.location.oid);
        }),
      ),
  );

  it.effect(
    "fetches unknown-size remote blobs in bounded ranges and freezes repository and size",
    () =>
      withStore(
        Effect.gen(function* () {
          const content = Buffer.alloc(3 * LIMIT + 17, 0x72);
          const oid = id("blob", content);
          const requests: Array<DriveHydration.HydrationRemoteRequest> = [];
          const test = yield* rig([], (request) => {
            requests.push(request);
            const bytes = content.subarray(request.offset, request.offset + request.length);
            return Effect.succeed({
              bytes,
              totalSize: content.length,
              complete: request.offset + bytes.length === content.length,
            });
          });
          const first = yield* test.step(oid);
          expect(first.size).toBe(content.length);
          expect(first.kind).toBe("blob");
          test.remoteRepository("changed/repository");
          test.promisedSize(42);
          expect((yield* Effect.flip(test.step(oid))).reason).toBe("source");
          expect(requests).toHaveLength(1);
          test.remoteRepository("original/repository");
          yield* test.finish(oid);
          expect(requests).toHaveLength(4);
          expect(
            requests.every(
              (request) => request.repository === "original/repository" && request.length <= LIMIT,
            ),
          ).toBe(true);
          expect((yield* test.store.status(oid))?.source).toEqual({
            kind: "remote",
            repository: "original/repository",
            size: null,
          });
          yield* expectContent(test.store, oid, content);
        }),
      ),
  );

  it.effect.each(["size", "range", "empty", "wrong-oid"] as const)(
    "rejects invalid remote %s responses",
    (fault) =>
      withStore(
        Effect.gen(function* () {
          const content = Buffer.alloc(2 * LIMIT, 0x72);
          const oid = fault === "wrong-oid" ? "f".repeat(40) : id("blob", content);
          const test = yield* rig([], (request) => {
            const bytes =
              fault === "empty"
                ? Buffer.alloc(0)
                : content.subarray(
                    request.offset,
                    request.offset + request.length + (fault === "range" ? 1 : 0),
                  );
            const totalSize = content.length + (fault === "size" && request.offset > 0 ? 1 : 0);
            return Effect.succeed({
              bytes,
              totalSize,
              complete: request.offset + bytes.length === totalSize,
            });
          });
          if (fault === "size" || fault === "wrong-oid") yield* test.step(oid);
          const error = yield* Effect.flip(test.step(oid));
          expect(error.reason).toBe(fault === "wrong-oid" ? "hash" : "range");
          expect((yield* test.store.status(oid))?.complete).toBe(false);
        }),
      ),
  );

  it.effect("verifies an empty remote object", () =>
    withStore(
      Effect.gen(function* () {
        const test = yield* rig([], () =>
          Effect.succeed({ bytes: new Uint8Array(), totalSize: 0, complete: true }),
        );
        const result = yield* test.step(id("blob", new Uint8Array()));
        expect(result.complete).toBe(true);
        expect(result.state.bytesWritten).toBe(0);
      }),
    ),
  );

  it.effect(
    "denies completed remote metadata after repository rebind and resumes when restored",
    () =>
      withStore(
        Effect.gen(function* () {
          const content = Buffer.from("cached remote bytes");
          const oid = id("blob", content);
          let ranges = 0;
          const test = yield* rig([], () => {
            ranges++;
            return Effect.succeed({ bytes: content, totalSize: content.length, complete: true });
          });
          const hydration = yield* test.fresh();
          const completed = yield* hydration.step(oid);
          expect(completed.complete).toBe(true);
          expect((yield* hydration.bytes(oid, 0, LIMIT)).bytes).toEqual(new Uint8Array(content));
          test.remoteRepository("changed/repository");
          expect((yield* Effect.flip(hydration.step(oid))).reason).toBe("source");
          expect((yield* Effect.flip(hydration.bytes(oid, 0, LIMIT))).reason).toBe("source");
          expect(yield* test.store.status(oid)).toEqual(completed.state);
          test.remoteRepository("original/repository");
          expect((yield* hydration.step(oid)).state).toEqual(completed.state);
          expect((yield* hydration.bytes(oid, 0, LIMIT)).bytes).toEqual(new Uint8Array(content));
          expect(ranges).toBe(1);
        }),
      ),
  );

  it.effect("preserves the remote adapter's structured error and its immediate cause", () =>
    withStore(
      Effect.gen(function* () {
        const oid = id("blob", Buffer.from("remote"));
        const cause = new Error("fixture remote range failed");
        const remoteError = new DriveHydration.HydrationRemoteError({ oid, cause });
        const test = yield* rig([], () => Effect.fail(remoteError));
        const error = yield* Effect.flip(test.step(oid));
        expect(error.reason).toBe("range");
        expect(error.cause).toBe(remoteError);
        expect(remoteError.cause).toBe(cause);
      }),
    ),
  );

  it.effect("rejects dependency cycles reconstructed from persisted checkpoints", () =>
    withStore(
      Effect.gen(function* () {
        const a = packed(Buffer.from("a"), {
          code: 7,
          base: Buffer.from(id("blob", Buffer.from("b")), "hex"),
        });
        const b = packed(Buffer.from("b"), {
          code: 7,
          base: Buffer.from(a.location.oid, "hex"),
          offset: a.location.offset + a.bytes.length,
        });
        const test = yield* rig([a, b]);
        yield* test.step(a.location.oid);
        const error = yield* Effect.flip(test.step(a.location.oid));
        expect(error.reason).toBe("dependency");
        expect((yield* test.store.status(a.location.oid))?.bytesWritten).toBe(0);
      }),
    ),
  );

  it.effect("rejects a chain longer than 64 objects before reading any payload", () =>
    withStore(
      Effect.gen(function* () {
        const contents = Array.from({ length: 65 }, (_, index) => Buffer.from(`chain-${index}`));
        let offset = 12;
        const objects = contents.map((content, index) => {
          const next = contents[index + 1];
          const object = packed(content, {
            offset,
            ...(next === undefined ? {} : { code: 7, base: Buffer.from(id("blob", next), "hex") }),
          });
          offset += object.bytes.length;
          return object;
        });
        const test = yield* rig(objects);
        const oid = objects[0]!.location.oid;
        for (let index = 0; index < 63; index++) yield* test.step(oid);
        const error = yield* Effect.flip(test.step(oid));
        expect(error.reason).toBe("dependency");
        expect(test.writes.every((write) => write.chunks.length === 0)).toBe(true);
      }),
    ),
  );

  it.effect("rejects an invalid persisted checkpoint and preserves range failures as causes", () =>
    withStore(
      Effect.gen(function* () {
        const fixture = packed(Buffer.from("checkpoint"));
        const test = yield* rig([fixture]);
        const partial = yield* test.step(fixture.location.oid);
        yield* test.store.advance({
          oid: fixture.location.oid,
          expectedRevision: partial.state.revision,
          expectedBytesWritten: 0,
          chunks: [],
          checkpoint: "{not-json",
          complete: false,
        });
        const error = yield* Effect.flip(test.step(fixture.location.oid));
        expect(error.reason).toBe("checkpoint");
        const hydration = yield* test.fresh();
        const badRange = yield* Effect.flip(hydration.bytes(fixture.location.oid, -1, LIMIT));
        expect(badRange.reason).toBe("range");
        expect(badRange.cause).toMatchObject({ _tag: "DriveObjectError" });
        expect((yield* Effect.flip(hydration.bytes("f".repeat(40), 0, LIMIT))).reason).toBe(
          "state",
        );
      }),
    ),
  );
});
