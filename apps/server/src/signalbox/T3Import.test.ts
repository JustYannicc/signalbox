// @effect-diagnostics nodeBuiltinImport:off - fixtures are built and hashed with node:sqlite and node:fs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as T3Import from "./T3Import.ts";

const decodeSettings = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

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
  NodeFS.writeFileSync(
    NodePath.join(sourceStateDir, "secrets", "provider-env-Y29kZXg-T1BFTkFJ.bin"),
    "sk",
  );
  NodeFS.writeFileSync(NodePath.join(sourceStateDir, "secrets", "dpop-proof-abc.bin"), "");
  NodeFS.writeFileSync(NodePath.join(sourceStateDir, "attachments", "thread-1", "a.png"), "png");
  NodeFS.writeFileSync(NodePath.join(sourceStateDir, "environment-id"), "env-t3");
  NodeFS.writeFileSync(NodePath.join(sourceStateDir, "connection-catalog.json"), "{}");
  NodeFS.writeFileSync(NodePath.join(sourceStateDir, "logs", "server.log"), "log");
  const database = new NodeSqlite.DatabaseSync(NodePath.join(sourceStateDir, "state.sqlite"));
  database.exec(
    [
      "PRAGMA journal_mode=WAL",
      "CREATE TABLE threads (id TEXT)",
      "INSERT INTO threads VALUES ('t1')",
      "CREATE TABLE auth_sessions (id TEXT)",
      "INSERT INTO auth_sessions VALUES ('phone')",
      "CREATE TABLE auth_pairing_links (id TEXT)",
      "INSERT INTO auth_pairing_links VALUES ('link')",
    ].join(";"),
  );
  database.close();
  return {
    sourceStateDir,
    targetStateDir: NodePath.join(root, ".signalbox", "userdata"),
  } satisfies T3Import.T3ImportPaths;
}

const ids = (database: string, table: string) => {
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    return db
      .prepare(`SELECT id FROM ${table} ORDER BY id`)
      .all()
      .map((row) => row.id);
  } finally {
    db.close();
  }
};
const threadIds = (database: string) => ids(database, "threads");

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
        "attachments",
        "secrets",
        "state.sqlite",
      ]);
      const target = paths.targetStateDir;
      assert.deepStrictEqual(threadIds(NodePath.join(target, "state.sqlite")), ["t1"]);
      assert.deepStrictEqual(
        decodeSettings(NodeFS.readFileSync(NodePath.join(target, "settings.json"), "utf8")),
        { a: 1, snapShotEnabled: false },
      );
      assert.equal(
        NodeFS.readFileSync(NodePath.join(target, "attachments", "thread-1", "a.png"), "utf8"),
        "png",
      );
      // Provider credentials come along; the server's identity and paired devices do not.
      assert.deepStrictEqual(NodeFS.readdirSync(NodePath.join(target, "secrets")), [
        "provider-env-Y29kZXg-T1BFTkFJ.bin",
      ]);
      assert.deepStrictEqual(ids(NodePath.join(target, "state.sqlite"), "auth_sessions"), []);
      assert.deepStrictEqual(ids(NodePath.join(target, "state.sqlite"), "auth_pairing_links"), []);
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

  it.effect("turns off imported SnapShot without changing T3 settings", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-import-" });
      const paths = writeT3Home(root);
      const sourceSettings = NodePath.join(paths.sourceStateDir, "settings.json");
      const t3Settings =
        '{"theme":"dark","snapShotEnabled":true,"snapShotIncludeAccessibility":false}';
      NodeFS.writeFileSync(sourceSettings, t3Settings);

      yield* T3Import.importT3Data(paths);

      assert.deepStrictEqual(
        decodeSettings(
          NodeFS.readFileSync(NodePath.join(paths.targetStateDir, "settings.json"), "utf8"),
        ),
        {
          theme: "dark",
          snapShotEnabled: false,
          snapShotIncludeAccessibility: false,
        },
      );
      assert.equal(NodeFS.readFileSync(sourceSettings, "utf8"), t3Settings);
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
      // The database and WAL are untouched. `-shm` is not compared: readers
      // record marks there, and the open writer rewrites it anyway.
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
