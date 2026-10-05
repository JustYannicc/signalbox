// @effect-diagnostics nodeBuiltinImport:off - node:sqlite takes the snapshot; the rest is Effect FileSystem.
/**
 * One-time import of an existing T3 Code install (`~/.t3/userdata`) into a
 * fresh Signalbox home. The import only ever reads the T3 home: files are
 * copied, the database is snapshotted with `VACUUM INTO`, and every write
 * lands under the Signalbox state dir.
 *
 * Users reach it from the desktop first-launch prompt, the CLI first-start
 * prompt (`T3ImportOffer.ts`), and `signalbox import-t3`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** T3 Code moved to statev2.sqlite; older homes only have state.sqlite, which seeds V2 on start. */
const DATABASE_FILES = ["statev2.sqlite", "state.sqlite"] as const;
const ImportedSettingsSchema = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));
const decodeImportedSettings = Schema.decodeEffect(ImportedSettingsSchema);
const encodeImportedSettings = Schema.encodeEffect(ImportedSettingsSchema);

/**
 * What the import brings over from `userdata`. An allowlist, so files upstream
 * adds later are skipped until someone decides they belong here. Deliberately
 * left behind: `environment-id` and `anonymous-id` (the two installs are
 * separate environments), `server-runtime.json`, logs, caches,
 * `desktop-settings.json` (per-app window, update, and exposure state),
 * `connection-catalog.json` and `clerk-tokens.json` (encrypted with T3 Code's
 * OS keychain entry, unreadable by Signalbox), and `cloud-auth-token.json`
 * (T3 Connect). Outside `userdata`, `worktrees/` is never copied: git registers
 * each worktree by absolute path, so imported threads keep using the existing
 * checkouts in place (see `T3WorktreeGuard`).
 */
const T3_IMPORT_ENTRIES = [
  "settings.json",
  "keybindings.json",
  "client-settings.json",
  "attachments",
  "browser-artifacts",
  "themes",
] as const;

/**
 * Secrets that hold credentials the user typed into settings: provider
 * environment variables, usage-limit sources, and Bitbucket tokens (see
 * `serverSettings.ts`). Everything else in `secrets/` identifies the T3 Code
 * server itself (session and asset signing keys, T3 Connect keys and replay
 * markers) and stays behind, so devices paired with T3 Code must pair again.
 */
const T3_IMPORT_SECRET_PREFIXES = ["provider-env-", "usage-limit-source-", "bitbucket-"] as const;

/** Paired devices and pending pairing links belong to the T3 Code server. */
const T3_IMPORT_CLEARED_TABLES = ["auth_sessions", "auth_pairing_links"] as const;

export interface T3ImportPaths {
  readonly sourceStateDir: string;
  readonly targetStateDir: string;
}

export class T3ImportUnavailableError extends Schema.TaggedError<T3ImportUnavailableError>()(
  "T3ImportUnavailableError",
  {
    reason: Schema.Literals(["source-missing", "target-has-data", "overlap"]),
    sourceStateDir: Schema.String,
    targetStateDir: Schema.String,
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "source-missing":
        return `No T3 Code data found at ${this.sourceStateDir}.`;
      case "target-has-data":
        return `Signalbox already has data in ${this.targetStateDir}, so nothing was imported. The import only fills a fresh Signalbox home: stop Signalbox, move that directory aside, and run the import again.`;
      case "overlap":
        return `The T3 Code data (${this.sourceStateDir}) and the Signalbox data (${this.targetStateDir}) share a directory, so nothing was imported.`;
    }
  }
}

export class T3ImportError extends Schema.TaggedError<T3ImportError>()("T3ImportError", {
  step: Schema.Literals([
    "copy-entry",
    "copy-secret",
    "snapshot-database",
    "scrub-database",
    "finalize-database",
  ]),
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Importing T3 Code data failed at ${this.step} (${this.path}). T3 Code's data was not changed.`;
  }
}

/** Keep the imported T3 global shortcut from firing in both apps. */
const resetImportedSnapShotSetting = Effect.fn("T3Import.resetImportedSnapShotSetting")(function* (
  settingsPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const fail = (cause: unknown) =>
    new T3ImportError({ step: "copy-entry", path: settingsPath, cause });
  const contents = yield* fs.readFileString(settingsPath).pipe(Effect.mapError(fail));
  const settings = yield* decodeImportedSettings(contents).pipe(Effect.mapError(fail));
  const encodedSettings = yield* encodeImportedSettings({
    ...settings,
    snapShotEnabled: false,
  }).pipe(Effect.mapError(fail));
  yield* fs.writeFileString(settingsPath, encodedSettings).pipe(Effect.mapError(fail));
});

/** The import source and target for a Signalbox home on this machine. */
export const defaultT3ImportPaths = Effect.fn("T3Import.defaultPaths")(function* (
  targetBaseDir: string,
) {
  const path = yield* Path.Path;
  return {
    sourceStateDir: path.join(NodeOS.homedir(), ".t3", "userdata"),
    targetStateDir: path.join(targetBaseDir, "userdata"),
  } satisfies T3ImportPaths;
});

const canonical = Effect.fn("T3Import.canonical")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Resolve symlinks on the deepest existing ancestor; the rest may not exist yet.
  let existing = path.resolve(target);
  const rest: string[] = [];
  while (!(yield* fs.exists(existing).pipe(Effect.orElseSucceed(() => false)))) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  const real = yield* fs.realPath(existing).pipe(Effect.orElseSucceed(() => existing));
  return path.join(real, ...rest);
});

/**
 * Whether `paths` can be imported: the source has a database, the target has
 * none, and neither directory contains the other.
 */
export const checkT3Import = Effect.fn("T3Import.check")(function* (paths: T3ImportPaths) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (reason: T3ImportUnavailableError["reason"]) =>
    new T3ImportUnavailableError({ reason, ...paths });
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));

  const source = yield* canonical(paths.sourceStateDir);
  const target = yield* canonical(paths.targetStateDir);
  const inside = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };
  if (inside(source, target) || inside(target, source)) return yield* fail("overlap");
  for (const file of DATABASE_FILES) {
    if (yield* exists(path.join(target, file))) return yield* fail("target-has-data");
  }
  for (const file of DATABASE_FILES) {
    if (yield* exists(path.join(source, file))) return file;
  }
  return yield* fail("source-missing");
});

const quoteSqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const withDatabase = <A>(
  file: string,
  readOnly: boolean,
  use: (database: NodeSqlite.DatabaseSync) => A,
) => {
  // A writer's checkpoint can hold the lock briefly; wait instead of failing.
  const database = new NodeSqlite.DatabaseSync(file, { readOnly, timeout: 5_000 });
  try {
    return use(database);
  } finally {
    database.close();
  }
};

const vacuumInto = (source: string, output: string, readOnly: boolean) =>
  withDatabase(source, readOnly, (database) => {
    database.exec(`VACUUM INTO ${quoteSqlString(output)}`);
  });

/**
 * Writes a consistent copy of `sourceDatabase` to `output`, never changing the
 * source's database or WAL file.
 *
 * Opening a WAL database, even read-only, creates `-wal` and `-shm` files when
 * they are missing, and readers record their position as marks in `-shm`. So:
 * - both exist: a writer (T3 Code) has the database open. Read it in place.
 *   The snapshot includes committed WAL content; the only bytes touched are
 *   reader marks in `-shm`, the shared-memory index the writer rewrites anyway.
 * - otherwise nothing has it open, so the files are stable: copy the database
 *   (and a WAL left by a crash) into `scratchDir` and snapshot the copy, which
 *   leaves the T3 home byte for byte unchanged.
 */
const snapshotSqliteDatabase = Effect.fn("T3Import.snapshotSqliteDatabase")(function* (input: {
  readonly sourceDatabase: string;
  readonly output: string;
  readonly scratchDir: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (file: string) => fs.exists(file).pipe(Effect.orElseSucceed(() => false));
  const fail = (cause: unknown) =>
    new T3ImportError({ step: "snapshot-database", path: input.sourceDatabase, cause });
  const hasWal = yield* exists(`${input.sourceDatabase}-wal`);
  const hasShm = yield* exists(`${input.sourceDatabase}-shm`);

  if (hasWal && hasShm) {
    return yield* Effect.try({
      try: () => vacuumInto(input.sourceDatabase, input.output, true),
      catch: fail,
    });
  }

  const scratch = path.join(input.scratchDir, `t3-import-${NodeCrypto.randomUUID()}`);
  yield* Effect.gen(function* () {
    const copy = path.join(scratch, path.basename(input.sourceDatabase));
    yield* Effect.all([
      fs.makeDirectory(scratch, { recursive: true }),
      fs.copyFile(input.sourceDatabase, copy),
      hasWal ? fs.copyFile(`${input.sourceDatabase}-wal`, `${copy}-wal`) : Effect.void,
    ]).pipe(Effect.mapError(fail));
    yield* Effect.try({ try: () => vacuumInto(copy, input.output, false), catch: fail });
  }).pipe(Effect.ensuring(fs.remove(scratch, { recursive: true }).pipe(Effect.ignore)));
});

const clearServerIdentityRows = (database: string) =>
  withDatabase(database, false, (db) => {
    const existing = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    for (const table of T3_IMPORT_CLEARED_TABLES) {
      if (existing.has(table)) db.exec(`DELETE FROM ${table}`);
    }
  });

const copySecrets = Effect.fn("T3Import.copySecrets")(function* (paths: T3ImportPaths) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const from = path.join(paths.sourceStateDir, "secrets");
  const to = path.join(paths.targetStateDir, "secrets");
  const fail = (cause: unknown) => new T3ImportError({ step: "copy-secret", path: from, cause });
  if (!(yield* fs.exists(from).pipe(Effect.orElseSucceed(() => false)))) return false;
  const names = (yield* fs.readDirectory(from).pipe(Effect.mapError(fail))).filter(
    (name) =>
      name.endsWith(".bin") && T3_IMPORT_SECRET_PREFIXES.some((prefix) => name.startsWith(prefix)),
  );
  if (names.length === 0) return false;
  yield* fs.makeDirectory(to, { recursive: true }).pipe(Effect.mapError(fail));
  yield* fs.chmod(to, 0o700).pipe(Effect.mapError(fail));
  for (const name of names) {
    yield* fs.copyFile(path.join(from, name), path.join(to, name)).pipe(Effect.mapError(fail));
    yield* fs.chmod(path.join(to, name), 0o600).pipe(Effect.mapError(fail));
  }
  return true;
});

/**
 * Copies T3 Code data into an empty Signalbox state dir. The database is
 * written last under a temporary name and renamed into place, so an import
 * that fails part way leaves no database and can simply run again.
 */
export const importT3Data = Effect.fn("T3Import.importT3Data")(function* (paths: T3ImportPaths) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const databaseFile = yield* checkT3Import(paths);

  const copied: string[] = [];
  yield* fs
    .makeDirectory(paths.targetStateDir, { recursive: true })
    .pipe(
      Effect.mapError(
        (cause) => new T3ImportError({ step: "copy-entry", path: paths.targetStateDir, cause }),
      ),
    );
  for (const entry of T3_IMPORT_ENTRIES) {
    const from = path.join(paths.sourceStateDir, entry);
    if (!(yield* fs.exists(from).pipe(Effect.orElseSucceed(() => false)))) continue;
    yield* fs
      .copy(from, path.join(paths.targetStateDir, entry), {
        overwrite: true,
        preserveTimestamps: true,
      })
      .pipe(
        Effect.mapError((cause) => new T3ImportError({ step: "copy-entry", path: from, cause })),
      );
    if (entry === "settings.json") {
      yield* resetImportedSnapShotSetting(path.join(paths.targetStateDir, entry));
    }
    copied.push(entry);
  }
  if (yield* copySecrets(paths)) copied.push("secrets");

  const database = path.join(paths.targetStateDir, databaseFile);
  const pending = `${database}.t3-import-${NodeCrypto.randomUUID()}`;
  yield* Effect.gen(function* () {
    yield* snapshotSqliteDatabase({
      sourceDatabase: path.join(paths.sourceStateDir, databaseFile),
      output: pending,
      scratchDir: paths.targetStateDir,
    });
    yield* Effect.try({
      try: () => clearServerIdentityRows(pending),
      catch: (cause) => new T3ImportError({ step: "scrub-database", path: pending, cause }),
    });
    yield* fs
      .rename(pending, database)
      .pipe(
        Effect.mapError(
          (cause) => new T3ImportError({ step: "finalize-database", path: database, cause }),
        ),
      );
  }).pipe(
    Effect.onError(() =>
      Effect.forEach([pending, `${pending}-journal`], (file) =>
        fs.remove(file, { force: true }).pipe(Effect.ignore),
      ),
    ),
  );
  copied.push(databaseFile);
  return { copied } as const;
});
