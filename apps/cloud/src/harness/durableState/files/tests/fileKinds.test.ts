import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { createHarnessFilesStore } from "../../../HarnessFilesStore.ts";
import type { HarnessFilesStoreFile } from "../../../HarnessFilesStore.ts";
import { hostSqlite } from "../../../tests/hostSqlite.ts";

const runId = "checkpoint-file-kinds";
const control = {
  ownerId: "owner",
  incarnationId: "owner-one",
  epoch: 1,
  controlKey: "control-key-".repeat(4),
};
const publisher = {
  generation: 1,
  facetNonce: "facet-one",
  publisherKey: "publisher-key-".repeat(4),
};
const regular = { path: "entry", mode: 0o640, bytes: new TextEncoder().encode("target") };
const initialize = (files: readonly HarnessFilesStoreFile[]) => ({
  type: "initialize",
  runId,
  control,
  publisher,
  checkpoint: { checkpointId: "checkpoint", parentCheckpointId: null, files },
});
const read = { type: "readCheckpoint", runId, publisher, checkpointId: "checkpoint" };

const database = () =>
  Effect.gen(function* () {
    const db = yield* Effect.acquireRelease(Effect.sync(hostSqlite), (value) =>
      Effect.sync(() => value.dispose()),
    );
    return yield* Effect.acquireRelease(
      Effect.sync(() => db.open()),
      (value) => Effect.sync(() => value.close()),
    );
  });

describe("durable checkpoint file kinds", () => {
  it.effect(
    "binds file kind into the manifest while preserving regular checkpoint identities",
    () =>
      Effect.gen(function* () {
        const implicitDb = yield* database();
        const explicitDb = yield* database();
        const symlinkDb = yield* database();
        const implicit = yield* createHarnessFilesStore(implicitDb.storage, runId).execute(
          initialize([regular]),
        );
        const explicit = yield* createHarnessFilesStore(explicitDb.storage, runId).execute(
          initialize([{ ...regular, kind: "file" }]),
        );
        const symlink = yield* createHarnessFilesStore(symlinkDb.storage, runId).execute(
          initialize([{ ...regular, kind: "symlink" }]),
        );
        expect(explicit.checkpoint).toEqual(implicit.checkpoint);
        expect(implicit.checkpoint.manifestSha256).toBe(
          "11a77f7408cd36b9ec9322574e5825f84899cb462357d22cbe04ce2702389ae8",
        );
        expect(symlink.checkpoint).not.toEqual(implicit.checkpoint);
        const restored = yield* createHarnessFilesStore(symlinkDb.storage, runId).execute(read);
        expect(restored.files).toEqual([{ ...regular, kind: "symlink" }]);
        const conflict = yield* createHarnessFilesStore(implicitDb.storage, runId)
          .execute(initialize([{ ...regular, kind: "symlink" }]))
          .pipe(Effect.flip);
        expect(conflict.code).toBe("CONFLICT");
      }),
  );

  it.effect.each(["readCheckpoint", "recoverCheckpoint"])(
    "migrates a legacy regular checkpoint on first %s without importing admission state",
    (type) =>
      Effect.gen(function* () {
        const db = yield* database();
        const original = yield* createHarnessFilesStore(db.storage, runId).execute(
          initialize([regular]),
        );
        db.exec("ALTER TABLE harness_files_entry DROP COLUMN kind");
        db.exec("DROP TABLE harness_files_admission_receipt");
        const originalState = db.rows("SELECT state_json FROM harness_files_meta");
        const restored = yield* createHarnessFilesStore(db.storage, runId).execute({
          ...read,
          type,
        });
        expect(restored.checkpoint).toEqual(original.checkpoint);
        expect(restored.files).toEqual([regular]);
        expect(db.rows("SELECT kind FROM harness_files_entry")).toEqual([{ kind: "file" }]);
        expect(
          db.rows("SELECT name FROM sqlite_master WHERE name = 'harness_files_admission_receipt'"),
        ).toEqual([]);
        expect(db.rows("SELECT state_json FROM harness_files_meta")).toEqual(originalState);
        const repeated = yield* createHarnessFilesStore(db.storage, runId).execute({
          ...read,
          type,
        });
        expect(repeated).toEqual(restored);
        const initialized = yield* createHarnessFilesStore(db.storage, runId).execute(
          initialize([regular]),
        );
        expect(initialized.checkpoint).toEqual(original.checkpoint);
        expect(db.rows("SELECT count(*) AS count FROM harness_files_admission_receipt")).toEqual([
          { count: 0 },
        ]);
      }),
  );

  it.effect.each(["readCheckpoint", "recoverCheckpoint"])(
    "rejects an unauthenticated legacy %s before migrating any schema",
    (type) =>
      Effect.gen(function* () {
        const db = yield* database();
        yield* createHarnessFilesStore(db.storage, runId).execute(initialize([regular]));
        db.exec("ALTER TABLE harness_files_entry DROP COLUMN kind");
        db.exec("DROP TABLE harness_files_admission_receipt");
        const schema = db.rows("SELECT name, sql FROM sqlite_master ORDER BY name");
        const error = yield* createHarnessFilesStore(db.storage, runId)
          .execute({
            ...read,
            type,
            publisher: { ...publisher, publisherKey: "wrong-publisher-key-".repeat(4) },
          })
          .pipe(Effect.flip);
        expect(error.code).toBe("STALE_PUBLISHER");
        expect(db.rows("SELECT name, sql FROM sqlite_master ORDER BY name")).toEqual(schema);
      }),
  );

  it.effect.each([
    { field: "kind", sql: "UPDATE harness_files_entry SET kind = 'file' WHERE path = 'entry'" },
    { field: "mode", sql: "UPDATE harness_files_entry SET mode = 511 WHERE path = 'entry'" },
    {
      field: "target",
      sql: "UPDATE harness_files_entry SET blob_sha256 = (SELECT blob_sha256 FROM harness_files_entry WHERE path = 'other') WHERE path = 'entry'",
    },
  ])("rejects a changed symlink $field under the committed manifest", ({ sql }) =>
    Effect.gen(function* () {
      const db = yield* database();
      yield* createHarnessFilesStore(db.storage, runId).execute(
        initialize([
          { ...regular, kind: "symlink" },
          { path: "other", mode: 0o644, bytes: new TextEncoder().encode("other!") },
        ]),
      );
      db.exec(sql);
      const error = yield* createHarnessFilesStore(db.storage, runId)
        .execute(read)
        .pipe(Effect.flip);
      expect(error.code).toBe("CORRUPT");
    }),
  );

  it.effect("rejects an unsupported entry kind before creating durable state", () =>
    Effect.gen(function* () {
      const db = yield* database();
      const error = yield* createHarnessFilesStore(db.storage, runId)
        .execute({
          ...initialize([]),
          checkpoint: {
            checkpointId: "checkpoint",
            parentCheckpointId: null,
            files: [{ ...regular, kind: "directory" }],
          },
        })
        .pipe(Effect.flip);
      expect(error.code).toBe("INVALID");
      expect(db.rows("SELECT name FROM sqlite_master WHERE name LIKE 'harness_files_%'")).toEqual(
        [],
      );
    }),
  );
});
