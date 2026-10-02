// @effect-diagnostics nodeBuiltinImport:off - node:sqlite takes the snapshot; the rest is Effect FileSystem.
/**
 * One-time import of an existing T3 Code install (`~/.t3/userdata`) into a
 * fresh Signalbox home. The import only ever reads the T3 home: files are
 * copied, the database is snapshotted with `VACUUM INTO`, and every write
 * lands under the Signalbox state dir.
 *
 * Users reach it from the desktop first-launch prompt, the CLI first-start
 * prompt, and `signalbox import-t3`.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";

import * as NodeTerminal from "@effect/platform-node/NodeTerminal";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Prompt } from "effect/unstable/cli";

import type { CliServerFlags } from "../cli/config.ts";
import { resolveBaseDir } from "../os-jank.ts";

const DATABASE_FILE = "state.sqlite";

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

export class T3ImportCancelledError extends Schema.TaggedError<T3ImportCancelledError>()(
  "T3ImportCancelledError",
  {},
) {
  override get message(): string {
    return "Startup cancelled.";
  }
}

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
  if (!(yield* exists(path.join(source, DATABASE_FILE)))) return yield* fail("source-missing");
  if (yield* exists(path.join(target, DATABASE_FILE))) return yield* fail("target-has-data");
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
    const copy = path.join(scratch, DATABASE_FILE);
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
  yield* checkT3Import(paths);

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
    copied.push(entry);
  }
  if (yield* copySecrets(paths)) copied.push("secrets");

  const database = path.join(paths.targetStateDir, DATABASE_FILE);
  const pending = `${database}.t3-import-${NodeCrypto.randomUUID()}`;
  yield* Effect.gen(function* () {
    yield* snapshotSqliteDatabase({
      sourceDatabase: path.join(paths.sourceStateDir, DATABASE_FILE),
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
  copied.push(DATABASE_FILE);
  return { copied } as const;
});

/** A prompt nobody answers (a detached terminal) must not hold startup forever. */
const PROMPT_TIMEOUT = Duration.minutes(2);

const ServerStartEnvironment = Config.all({
  t3Home: Config.String("T3CODE_HOME").pipe(Config.option),
  mode: Config.String("T3CODE_MODE").pipe(Config.option),
  devUrl: Config.String("VITE_DEV_SERVER_URL").pipe(Config.option),
  bootstrapFd: Config.String("T3CODE_BOOTSTRAP_FD").pipe(Config.option),
});

/**
 * Offers the import when a CLI-started server first runs on the default home.
 * An interactive terminal gets a yes/no prompt (Ctrl+C cancels startup);
 * anything else (services, scripts) gets a log line, because nothing is
 * imported without the user choosing it. The desktop app asks with its own
 * dialog before it starts the backend, which arrives here with a bootstrap fd.
 */
export const offerT3ImportOnServerStart = Effect.fn("T3Import.offerOnServerStart")(function* (
  flags: CliServerFlags,
) {
  const env = yield* ServerStartEnvironment;
  const some = (value: Option.Option<unknown> | undefined) =>
    value !== undefined && Option.isSome(value);
  if (
    some(flags.baseDir) ||
    some(env.t3Home) ||
    some(flags.bootstrapFd) ||
    some(env.bootstrapFd) ||
    some(flags.devUrl) ||
    some(env.devUrl) ||
    Option.getOrUndefined(flags.mode ?? Option.none()) === "desktop" ||
    Option.getOrUndefined(env.mode) === "desktop"
  ) {
    return;
  }
  const paths = yield* defaultT3ImportPaths(yield* resolveBaseDir(undefined));
  const available = yield* checkT3Import(paths).pipe(
    Effect.as(true),
    Effect.catchTag("T3ImportUnavailableError", () => Effect.succeed(false)),
  );
  if (!available) return;

  const hint = `Found T3 Code data in ${paths.sourceStateDir}. Signalbox is starting with an empty home; to copy that data over instead, stop Signalbox, move ${paths.targetStateDir} aside, and run \`signalbox import-t3\`.`;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    yield* Effect.logInfo(hint);
    return;
  }
  const answer = yield* Prompt.run(
    Prompt.Confirm({
      message: `Found T3 Code data in ${paths.sourceStateDir}. Copy your projects, threads, and settings into Signalbox? T3 Code's data stays as it is.`,
      initial: true,
    }),
  ).pipe(
    Effect.catchTag("QuitError", () => Effect.fail(new T3ImportCancelledError())),
    Effect.timeoutOption(PROMPT_TIMEOUT),
    Effect.provide(NodeTerminal.layer),
  );
  if (Option.isNone(answer)) {
    yield* Effect.logInfo(hint);
    return;
  }
  if (!answer.value) return;
  yield* Console.log("Copying T3 Code data. Large histories can take a minute.");
  yield* importT3Data(paths);
  yield* Console.log(`Imported T3 Code data into ${paths.targetStateDir}.`);
});
