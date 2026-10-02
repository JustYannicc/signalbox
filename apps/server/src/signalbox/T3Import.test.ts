// @effect-diagnostics nodeBuiltinImport:off - fixtures are built and hashed with node:sqlite and node:fs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as T3Import from "./T3Import.ts";

/** Every file under `dir` with its sha256, so "unchanged" means byte for byte. */
function fingerprint(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of NodeFS.readdirSync(current, { withFileTypes: true })) {
      const full = NodePath.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        result[NodePath.relative(dir, full)] = NodeCrypto.createHash("sha256")
          .update(NodeFS.readFileSync(full))
          .digest("hex");
      }
    }
  };
  walk(dir);
  return result;
}

function writeT3Home(root: string) {
  const sourceStateDir = NodePath.join(root, ".t3", "userdata");
  NodeFS.mkdirSync(NodePath.join(sourceStateDir, "secrets"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(sourceStateDir, "attachments", "thread-1"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(sourceStateDir, "logs"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(root, ".t3", "worktrees", "repo", "branch"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(sourceStateDir, "settings.json"), '{"a":1}');
  NodeFS.writeFileSync(NodePath.join(sourceStateDir, "secrets", "server-signing-key.bin"), "key");
  NodeFS.writeFileSync(NodePath.join(sourceStateDir, "attachments", "thread-1", "a.png"), "png");
  NodeFS.writeFileSync(NodePath.join(sourceStateDir, "environment-id"), "env-t3");
  NodeFS.writeFileSync(NodePath.join(sourceStateDir, "connection-catalog.json"), "{}");
  NodeFS.writeFileSync(NodePath.join(sourceStateDir, "logs", "server.log"), "log");
  const database = new NodeSqlite.DatabaseSync(NodePath.join(sourceStateDir, "state.sqlite"));
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE threads (id TEXT); INSERT INTO threads VALUES ('t1');",
  );
  database.close();
  return {
    sourceStateDir,
    targetStateDir: NodePath.join(root, ".signalbox", "userdata"),
  } satisfies T3Import.T3ImportPaths;
}

const threadIds = (database: string) => {
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    return db
      .prepare("SELECT id FROM threads ORDER BY id")
      .all()
      .map((row) => row.id);
  } finally {
    db.close();
  }
};

it.layer(NodeServices.layer)("T3 Code import", (it) => {
  it.effect("copies the allowlisted data and leaves the T3 home byte for byte unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-import-" });
      const paths = writeT3Home(root);
      const before = fingerprint(NodePath.join(root, ".t3"));

      const result = yield* T3Import.importT3Data(paths);

      assert.deepStrictEqual(fingerprint(NodePath.join(root, ".t3")), before);
      assert.deepStrictEqual(result.copied, [
        "settings.json",
        "secrets",
        "attachments",
        "state.sqlite",
      ]);
      const target = paths.targetStateDir;
      assert.deepStrictEqual(threadIds(NodePath.join(target, "state.sqlite")), ["t1"]);
      assert.equal(NodeFS.readFileSync(NodePath.join(target, "settings.json"), "utf8"), '{"a":1}');
      assert.equal(
        NodeFS.readFileSync(NodePath.join(target, "attachments", "thread-1", "a.png"), "utf8"),
        "png",
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(target, "secrets", "server-signing-key.bin"), "utf8"),
        "key",
      );
      for (const skipped of ["environment-id", "connection-catalog.json", "logs"]) {
        assert.isFalse(NodeFS.existsSync(NodePath.join(target, skipped)), skipped);
      }
      assert.isFalse(NodeFS.existsSync(NodePath.join(root, ".signalbox", "worktrees")));
      assert.deepStrictEqual(
        NodeFS.readdirSync(target).filter((name) => name.includes("t3-import")),
        [],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("snapshots committed WAL content while another connection holds the database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-import-" });
      const paths = writeT3Home(root);
      const source = NodePath.join(paths.sourceStateDir, "state.sqlite");
      const writer = new NodeSqlite.DatabaseSync(source);
      yield* Effect.addFinalizer(() => Effect.sync(() => writer.close()));
      writer.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO threads VALUES ('t2');");
      const mainBefore = NodeFS.readFileSync(source);
      const walBefore = NodeFS.readFileSync(`${source}-wal`);

      yield* T3Import.importT3Data(paths);

      assert.deepStrictEqual(threadIds(NodePath.join(paths.targetStateDir, "state.sqlite")), [
        "t1",
        "t2",
      ]);
      assert.isTrue(NodeFS.readFileSync(source).equals(mainBefore));
      assert.isTrue(NodeFS.readFileSync(`${source}-wal`).equals(walBefore));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a crashed writer's WAL pages without touching the source", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-import-" });
      const paths = writeT3Home(root);
      const source = NodePath.join(paths.sourceStateDir, "state.sqlite");
      const writer = new NodeSqlite.DatabaseSync(source);
      writer.exec("PRAGMA wal_autocheckpoint=0; INSERT INTO threads VALUES ('t2');");
      // Simulate a crash: keep the WAL, lose the shm index.
      const wal = NodeFS.readFileSync(`${source}-wal`);
      const main = NodeFS.readFileSync(source);
      writer.close();
      NodeFS.writeFileSync(source, main);
      NodeFS.writeFileSync(`${source}-wal`, wal);
      NodeFS.rmSync(`${source}-shm`, { force: true });
      const before = fingerprint(paths.sourceStateDir);

      yield* T3Import.importT3Data(paths);

      assert.deepStrictEqual(fingerprint(paths.sourceStateDir), before);
      assert.deepStrictEqual(threadIds(NodePath.join(paths.targetStateDir, "state.sqlite")), [
        "t1",
        "t2",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a target that already has a database and changes nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-import-" });
      const paths = writeT3Home(root);
      NodeFS.mkdirSync(paths.targetStateDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(paths.targetStateDir, "state.sqlite"), "existing");
      const before = fingerprint(NodePath.join(root, ".signalbox"));

      const error = yield* Effect.flip(T3Import.importT3Data(paths));

      assert.equal(error._tag === "T3ImportUnavailableError" && error.reason, "target-has-data");
      assert.deepStrictEqual(fingerprint(NodePath.join(root, ".signalbox")), before);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses when there is no T3 Code database or the directories overlap", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-import-" });
      const missing = yield* Effect.flip(
        T3Import.checkT3Import({
          sourceStateDir: NodePath.join(root, ".t3", "userdata"),
          targetStateDir: NodePath.join(root, ".signalbox", "userdata"),
        }),
      );
      assert.equal(missing.reason, "source-missing");

      const paths = writeT3Home(root);
      const overlap = yield* Effect.flip(
        T3Import.checkT3Import({
          sourceStateDir: paths.sourceStateDir,
          targetStateDir: NodePath.join(paths.sourceStateDir, "nested"),
        }),
      );
      assert.equal(overlap.reason, "overlap");
    }).pipe(Effect.scoped),
  );
});
