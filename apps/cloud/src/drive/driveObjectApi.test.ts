// @effect-diagnostics nodeBuiltinImport:off - tests reopen an isolated SQLite file after disposing its runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
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

const runtimeFor = (filename: string) =>
  ManagedRuntime.make(
    DriveStore.layer(DRIVE).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename }))),
  );

describe("drive object metadata API", () => {
  it("resumes persisted metadata through a new object API after its runtime is disposed", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "drive-metadata-api-"));
    const filename = NodePath.join(directory, "state.sqlite");
    let runtime = runtimeFor(filename);
    try {
      await runtime.runPromise(DriveStore.DriveStore.use((store) => store.initialize));
      const first = DriveDirectory.handleFor(
        makeDriveObjectApi((effect) => runtime.runPromise(effect)),
      );
      expect(await runtime.runPromise(first.metadataStatus(oid))).toBeNull();
      const initial = await runtime.runPromise(first.metadataBegin(oid, source));
      expect(initial.source).toEqual(source);
      const partial = await runtime.runPromise(
        first.metadataAdvance({
          oid,
          expectedRevision: 0,
          expectedBytesWritten: 0,
          chunks: [new Uint8Array([1, 2, 3])],
          checkpoint: "v1:partial object and hash state",
          complete: false,
        }),
      );
      expect(partial._tag).toBe("advanced");
      await runtime.dispose();

      runtime = runtimeFor(filename);
      await runtime.runPromise(DriveStore.DriveStore.use((store) => store.initialize));
      const resumed = DriveDirectory.handleFor(
        makeDriveObjectApi((effect) => runtime.runPromise(effect)),
      );
      expect(await runtime.runPromise(resumed.metadataStatus(oid))).toEqual(partial.state);
      expect(
        await runtime.runPromise(
          resumed.metadataBegin(oid, {
            kind: "remote",
            repository: "different/repository",
            size: null,
          }),
        ),
      ).toEqual(partial.state);
      expect(await runtime.runPromise(resumed.metadataBytes(oid, 1, 6))).toEqual({
        _tag: "pending",
        bytes: new Uint8Array([2, 3]),
        nextOffset: 3,
      });
      const final = await runtime.runPromise(
        resumed.metadataAdvance({
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
      expect(await runtime.runPromise(resumed.metadataBytes(oid, 0, 6))).toEqual({
        _tag: "complete",
        bytes: new Uint8Array([1, 2, 3, 4, 5, 6]),
        nextOffset: 6,
      });
    } finally {
      await runtime.dispose();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

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
