// @effect-diagnostics nodeBuiltinImport:off - tests close and reopen an isolated SQLite file.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as DriveDirectory from "./DriveDirectory.ts";
import * as DriveMetadata from "./DriveMetadata.ts";
import * as DriveStore from "./DriveStore.ts";
import { makeDriveObjectApi } from "./driveObjectApi.ts";
import { makeMemoryDrives } from "./driveTesting.ts";

const DRIVE = "my/personal/user_metadata";
const oid = "0123456789abcdef0123456789abcdef01234567";
const source: DriveMetadata.MetadataSource = {
  kind: "pack",
  location: {
    oid,
    pack: "original-pack",
    offset: 42,
    length: 100,
    type: "tree",
    size: 6,
    storageDriveId: "original-drive",
  },
};

type ApiRequest = Parameters<Parameters<typeof makeDriveObjectApi>[0]>[0];

// The test fiber evaluates each requested Effect; the Promise adapter owns no runtime.
const scopedApi = () => {
  let requested: Effect.Effect<void, never, Effect.Services<ApiRequest>> | undefined;
  const api = makeDriveObjectApi(
    (effect) =>
      new Promise((resolve, reject) => {
        requested = effect.pipe(Effect.match({ onSuccess: resolve, onFailure: reject }));
      }),
  );
  return <A>(call: (api: DriveDirectory.DriveObjectApi) => Promise<A>) =>
    Effect.gen(function* () {
      const result = call(api);
      const request = requested;
      requested = undefined;
      if (request === undefined)
        return yield* Effect.die("The object API did not request an Effect.");
      yield* request;
      return yield* Effect.promise(() => result);
    });
};

describe("drive object metadata API", () => {
  it.effect("resumes persisted metadata through a new object API after closing its SQL scope", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() =>
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "drive-metadata-api-")),
        ),
        (directory) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const filename = NodePath.join(directory, "state.sqlite");
      const layerFor = () =>
        DriveStore.layer(DRIVE).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));
      const partial = yield* Effect.gen(function* () {
        yield* DriveStore.DriveStore.use((store) => store.initialize);
        const first = scopedApi();
        expect(yield* first((api) => api.metadataStatus(oid))).toBeNull();
        const initial = yield* first((api) => api.metadataBegin(oid, source));
        expect(initial.source).toEqual(source);
        const partial = yield* first((api) =>
          api.metadataAdvance({
            oid,
            expectedRevision: 0,
            expectedBytesWritten: 0,
            chunks: [new Uint8Array([1, 2, 3])],
            checkpoint: "v1:partial object and hash state",
            complete: false,
          }),
        );
        expect(partial._tag).toBe("advanced");
        return partial;
      }).pipe(Effect.provide(layerFor()), Effect.scoped);

      yield* Effect.gen(function* () {
        yield* DriveStore.DriveStore.use((store) => store.initialize);
        const resumed = scopedApi();
        expect(yield* resumed((api) => api.metadataStatus(oid))).toEqual(partial.state);
        expect(
          yield* resumed((api) =>
            api.metadataBegin(oid, {
              kind: "remote",
              repository: "different/repository",
              size: null,
            }),
          ),
        ).toEqual(partial.state);
        expect(yield* resumed((api) => api.metadataBytes(oid, 1, 6))).toEqual({
          _tag: "pending",
          bytes: new Uint8Array([2, 3]),
          nextOffset: 3,
        });
        const final = yield* resumed((api) =>
          api.metadataAdvance({
            oid,
            expectedRevision: 1,
            expectedBytesWritten: 3,
            chunks: [new Uint8Array([4, 5, 6])],
            checkpoint: null,
            complete: true,
          }),
        );
        expect(final).toMatchObject({
          _tag: "advanced",
          state: { revision: 2, bytesWritten: 6, checkpoint: null, complete: true },
        });
        expect(yield* resumed((api) => api.metadataBytes(oid, 0, 6))).toEqual({
          _tag: "complete",
          bytes: new Uint8Array([1, 2, 3, 4, 5, 6]),
          nextOffset: 6,
        });
      }).pipe(Effect.provide(layerFor()), Effect.scoped);
    }).pipe(Effect.scoped),
  );

  it.effect("adds metadata storage to an existing drive despite a higher migration id", () =>
    Effect.gen(function* () {
      const store = yield* DriveStore.DriveStore;
      const sql = yield* SqlClient.SqlClient;
      yield* store.initialize;
      yield* sql`INSERT INTO refs (name, oid, updated_by, updated_at)
        VALUES ('main', ${oid}, 'user_metadata', 1)`;
      yield* sql`DROP TABLE drive_metadata_chunks`;
      yield* sql`DROP TABLE drive_metadata_objects`;
      yield* sql`DELETE FROM effect_sql_migrations
        WHERE migration_id = 12 AND name = 'drive_metadata'`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (13, 'later_migration')`;

      yield* store.initialize;
      const metadata = yield* DriveMetadata.DriveMetadata;
      expect(yield* metadata.begin(oid, source)).toMatchObject({ revision: 0, source });
      expect(yield* store.ref("main")).toBe(oid);
      expect(
        yield* sql`SELECT name FROM effect_sql_migrations
          WHERE migration_id = 12 AND name = 'drive_metadata'`,
      ).toEqual([{ name: "drive_metadata" }]);
    }).pipe(
      Effect.provide(
        DriveStore.layer(DRIVE).pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
  );

  it.effect("serves metadata from the memory object harness and wraps service failures", () => {
    const drives = makeMemoryDrives();
    return Effect.gen(function* () {
      const directory = yield* DriveDirectory.DriveDirectory;
      const handle = directory.forDrive(DRIVE);
      yield* handle.metadataBegin(oid, source);
      const error = yield* handle.metadataBytes(oid, -1, 1).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "DriveObjectError",
        operation: "metadataBytes",
        cause: { _tag: "MetadataInputError", reason: "range" },
      });
      expect(yield* handle.metadataStatus(oid)).toMatchObject({
        revision: 0,
        bytesWritten: 0,
      });
    }).pipe(Effect.provide(drives.layer));
  });
});
