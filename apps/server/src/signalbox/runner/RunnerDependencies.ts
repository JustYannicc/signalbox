import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { MachineCaches } from "./RunnerCaches.ts";

/**
 * Keeps every dependency tree in a thread's checkout in step with its
 * lockfile, before each turn starts (#133), so the agent finds dependencies
 * installed and never builds against stale ones.
 *
 * A dependency root is a directory, at most two levels into the checkout and
 * outside dot directories and symlinks, with a lockfile this machine installs
 * (pnpm or npm). Its key hashes the lockfile, the package manager's other
 * install inputs and the machine's toolchain, and its `node_modules` records
 * the key and how its last install went:
 *
 * - **Installed at this key:** the tree is reused as it is, with the build
 *   caches tools keep inside it (Vite's task cache and dependency optimizer,
 *   `.cache`).
 * - **Another key** (the lockfile or the toolchain changed), **no tree**, or
 *   **an install that never finished:** every `node_modules` under the root
 *   is discarded and the lockfile is installed fresh from the machine's warm
 *   store. Nothing built against other dependencies or another toolchain
 *   survives the rebuild.
 * - **A tree with no record** (the agent installed it in an earlier turn):
 *   the lockfile is installed over it, which leaves a tree already in step
 *   untouched, and the key is recorded.
 * - **Failed at this key:** not retried until the key changes; the turn that
 *   hit the failure reported it, and the agent can install by hand.
 */

type PackageManager = "pnpm" | "npm";

/** Lockfiles this machine installs, in the order each package manager prefers them. */
const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["npm-shrinkwrap.json", "npm"],
  ["package-lock.json", "npm"],
];

/** Files besides the lockfile that change what an install produces. */
const INSTALL_INPUTS: Record<PackageManager, ReadonlyArray<string>> = {
  pnpm: ["pnpm-workspace.yaml", ".npmrc", ".pnpmfile.cjs", ".pnpmfile.mjs"],
  npm: [".npmrc"],
};

/** The parts of package.json that change what an install produces, not its scripts. */
const MANIFEST_INPUTS = ["packageManager", "pnpm", "overrides", "resolutions"];

const INSTALL: Record<PackageManager, ReadonlyArray<string>> = {
  pnpm: ["pnpm", "install", "--frozen-lockfile", "--config.confirm-modules-purge=false"],
  npm: ["npm", "ci", "--no-audit", "--no-fund"],
};

/**
 * Every `node_modules` under the working directory, outside dot directories.
 * `find` never follows symlinks and lists each tree without walking into it.
 */
const FIND_TREES = [
  "find",
  ".",
  "-mindepth",
  "1",
  "(",
  "-name",
  ".*",
  "-prune",
  ")",
  "-o",
  "(",
  "-type",
  "d",
  "-name",
  "node_modules",
  "-print",
  "-prune",
  ")",
];

const MAX_DEPTH = 2;
const RECORD = ".signalbox-dependencies.json";
const INSTALL_TIMEOUT = "30 minutes";
/** Install output kept for a failure's report. */
const INSTALL_OUTPUT_TAIL = 4096;

const DependencyRecord = Schema.fromJsonString(
  Schema.Struct({
    toolchain: Schema.String,
    inputs: Schema.String,
    state: Schema.Literals(["installing", "installed", "failed"]),
  }),
);
type DependencyRecord = typeof DependencyRecord.Type;
const decodeRecord = Schema.decodeUnknownOption(DependencyRecord);
const encodeRecord = Schema.encodeSync(DependencyRecord);
const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface DependencyRoot {
  readonly directory: string;
  /** Relative to the checkout; empty for the checkout itself. */
  readonly relative: string;
  readonly lockfile: string;
  readonly manager: PackageManager;
}

type InstallReason = "new" | "lockfile" | "toolchain" | "unfinished" | "adopted";

type DependencyOutcome =
  | { readonly _tag: "reused" }
  | { readonly _tag: "skipped" }
  | { readonly _tag: "installed"; readonly reason: InstallReason; readonly durationMs: number }
  | { readonly _tag: "failed"; readonly message: string; readonly durationMs: number };

export interface RunnerDependencies {
  /** Brings every root in the checkout in step; `notify` hears what the user should. */
  readonly prepare: (
    notify: (message: string) => Effect.Effect<void>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly root: DependencyRoot; readonly outcome: DependencyOutcome }>
  >;
}

const where = (root: DependencyRoot) =>
  root.relative === "" ? "this folder" : `${root.relative}/`;

/** What the user hears before an install; adopting a tree the agent made is quiet. */
const NOTICES: Record<Exclude<InstallReason, "adopted">, (root: DependencyRoot) => string> = {
  new: (root) => `Installing dependencies in ${where(root)} from ${root.lockfile}.`,
  lockfile: (root) =>
    `${root.lockfile} changed, so dependencies in ${where(root)} are reinstalled.`,
  toolchain: (root) =>
    `This machine's toolchain changed, so dependencies in ${where(root)} are reinstalled.`,
  unfinished: (root) =>
    `The last install in ${where(root)} did not finish, so dependencies are reinstalled.`,
};

/** What a tree needs: an install and why, a reuse, or nothing until its key changes. */
const planFor = (
  hasTree: boolean,
  recorded: DependencyRecord | null,
  inputs: string,
  toolchain: string,
): InstallReason | "reuse" | "skip" => {
  if (!hasTree) return "new";
  if (recorded === null) return "adopted";
  if (recorded.toolchain !== toolchain) return "toolchain";
  if (recorded.inputs !== inputs) return "lockfile";
  switch (recorded.state) {
    case "installing":
      return "unfinished";
    case "failed":
      return "skip";
    case "installed":
      return "reuse";
  }
};

/** Lets an interrupt through; anything else becomes `orElse`. */
const unlessInterrupted =
  <A, R>(orElse: (cause: Cause.Cause<unknown>) => Effect.Effect<A, never, R>) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<A, never, R> =>
    // An interrupt-only cause holds no failure, so it fails with nothing.
    Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : orElse(cause);

export const makeRunnerDependencies = Effect.fn("makeRunnerDependencies")(function* (input: {
  /** The thread's working directory. */
  readonly cwd: string;
  readonly caches: MachineCaches;
  /** What installs run with: the harnesses' own environment, the caches' variables included. */
  readonly environment: Readonly<Record<string, string | undefined>>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.environment)) {
    if (value !== undefined) environment[name] = value;
  }

  const readOrNull = (file: string) =>
    fs.readFileString(file).pipe(Effect.orElseSucceed(() => null));

  /** A directory and not a symlink, which could lead outside the checkout or in circles. */
  const isDirectory = (file: string) =>
    fs.readLink(file).pipe(
      Effect.as(false),
      Effect.catch(() => fs.stat(file).pipe(Effect.map((info) => info.type === "Directory"))),
      Effect.orElseSucceed(() => false),
    );

  const findRoots = Effect.gen(function* () {
    const roots: Array<DependencyRoot> = [];
    const visit = (relative: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        const directory = path.join(input.cwd, relative);
        const entries = yield* fs
          .readDirectory(directory)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        const found = LOCKFILES.find(([lockfile]) => entries.includes(lockfile));
        if (found !== undefined) {
          roots.push({ directory, relative, lockfile: found[0], manager: found[1] });
        }
        if (depth === MAX_DEPTH) return;
        const children = yield* Effect.filter(
          entries.filter((entry) => !entry.startsWith(".") && entry !== "node_modules").sort(),
          (entry) => isDirectory(path.join(directory, entry)),
          { concurrency: 16 },
        );
        for (const entry of children) {
          yield* visit(relative === "" ? entry : path.join(relative, entry), depth + 1);
        }
      });
    yield* visit("", 0);
    return roots;
  });

  const inputsOf = (root: DependencyRoot) =>
    Effect.gen(function* () {
      const files = [root.lockfile, ...INSTALL_INPUTS[root.manager]];
      const contents = yield* Effect.forEach(
        files,
        (file) => readOrNull(path.join(root.directory, file)),
        { concurrency: "unbounded" },
      );
      // An unreadable manifest fails the install, which reports it.
      const fields = Option.getOrElse(
        decodeManifest(yield* readOrNull(path.join(root.directory, "package.json"))),
        (): Readonly<Record<string, unknown>> => ({}),
      );
      const parts = [
        root.manager,
        ...files.flatMap((file, index) => [file, contents[index] ?? ""]),
        encodeJson(
          Object.fromEntries(MANIFEST_INPUTS.map((field) => [field, fields[field] ?? null])),
        ),
      ];
      const digest = yield* crypto.digest(
        "SHA-256",
        new TextEncoder().encode(parts.map((part) => `${part.length}:${part}`).join("")),
      );
      return Hex.encode(digest);
    });

  /** Runs `command` in `cwd`; keeps its stdout, and the last `tail` characters of all output. */
  const run = (cwd: string, [command, ...args]: ReadonlyArray<string>, tail = Infinity) =>
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(command!, args, {
          cwd,
          env: environment,
          extendEnv: false,
          stdin: "ignore",
        }),
      );
      let stdout = "";
      let output = "";
      const keep = (into: "stdout" | "stderr") => (text: string) =>
        Effect.sync(() => {
          if (into === "stdout" && tail === Infinity) stdout += text;
          output = (output + text).slice(-tail);
        });
      const [, , code] = yield* Effect.all(
        [
          Stream.runForEach(Stream.decodeText(child.stdout), keep("stdout")),
          Stream.runForEach(Stream.decodeText(child.stderr), keep("stderr")),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { code: Number(code), stdout, output };
    }).pipe(Effect.scoped);

  /** Every `node_modules` under `root`, outside dot directories and other roots. */
  const treesOf = (root: DependencyRoot, others: ReadonlySet<string>) =>
    run(root.directory, FIND_TREES).pipe(
      Effect.map(({ stdout }) =>
        stdout
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => path.join(root.directory, line))
          .filter(
            (tree) => ![...others].some((other) => tree === other || tree.startsWith(`${other}/`)),
          ),
      ),
    );

  const install = (root: DependencyRoot) =>
    run(root.directory, INSTALL[root.manager], INSTALL_OUTPUT_TAIL).pipe(
      Effect.timeoutOrElse({
        duration: INSTALL_TIMEOUT,
        orElse: () => Effect.succeed({ code: -1, output: `Timed out after ${INSTALL_TIMEOUT}.` }),
      }),
      Effect.catchCause(
        unlessInterrupted((cause) => Effect.succeed({ code: -1, output: Cause.pretty(cause) })),
      ),
    );

  const prepareRoot = (
    root: DependencyRoot,
    others: ReadonlySet<string>,
    notify: (message: string) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      const tree = path.join(root.directory, "node_modules");
      const recordFile = path.join(tree, RECORD);
      const inputs = yield* inputsOf(root);
      const record = (state: DependencyRecord["state"]) =>
        fs
          .makeDirectory(tree, { recursive: true })
          .pipe(
            Effect.andThen(
              fs.writeFileString(
                recordFile,
                encodeRecord({ toolchain: input.caches.toolchain, inputs, state }),
              ),
            ),
          );
      const hasTree = yield* isDirectory(tree);
      const recorded = hasTree
        ? Option.getOrNull(decodeRecord(yield* readOrNull(recordFile)))
        : null;
      const plan = planFor(hasTree, recorded, inputs, input.caches.toolchain);
      if (plan === "reuse") {
        yield* Effect.logInfo("dependencies reused", { root: root.relative });
        return { _tag: "reused" } as const;
      }
      if (plan === "skip") {
        yield* Effect.logInfo("dependencies failed at this key before; not retried", {
          root: root.relative,
        });
        return { _tag: "skipped" } as const;
      }
      const started = yield* Clock.currentTimeMillis;
      if (plan !== "adopted") {
        yield* notify(NOTICES[plan](root));
        for (const stale of yield* treesOf(root, others)) yield* input.caches.discard(stale);
      }
      // Marks the tree, so an install cut short is never taken for a finished one.
      yield* record("installing");
      const result = yield* install(root);
      const durationMs = (yield* Clock.currentTimeMillis) - started;
      if (result.code !== 0) {
        yield* record("failed");
        const last = result.output.trim().split("\n").at(-1) ?? "";
        yield* Effect.logWarning("dependency install failed", {
          root: root.relative,
          manager: root.manager,
          code: result.code,
          durationMs,
          output: result.output,
        });
        const message = `Installing dependencies in ${where(root)} failed${last === "" ? "." : `: ${last}`}`;
        yield* notify(message);
        return { _tag: "failed", message, durationMs } as const;
      }
      yield* record("installed");
      yield* Effect.logInfo("dependencies installed", {
        root: root.relative,
        manager: root.manager,
        reason: plan,
        durationMs,
      });
      return { _tag: "installed", reason: plan, durationMs } as const;
    });

  const prepare: RunnerDependencies["prepare"] = (notify) =>
    Effect.gen(function* () {
      const roots = yield* findRoots;
      const directories = new Set(roots.map((root) => root.directory));
      const results: Array<{ root: DependencyRoot; outcome: DependencyOutcome }> = [];
      for (const root of roots) {
        const others = new Set([...directories].filter((other) => other !== root.directory));
        const outcome = yield* prepareRoot(root, others, notify).pipe(
          Effect.catchCause(
            unlessInterrupted((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("preparing dependencies failed", Cause.pretty(cause));
                const message = `Preparing dependencies in ${where(root)} failed.`;
                yield* notify(message);
                return { _tag: "failed", message, durationMs: 0 } as const;
              }),
            ),
          ),
        );
        results.push({ root, outcome });
      }
      return results;
    });

  return { prepare } satisfies RunnerDependencies;
});
