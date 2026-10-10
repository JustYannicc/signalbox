import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as PlatformError from "effect/PlatformError";

/**
 * A machine's dependency and build caches (#133), kept apart from every
 * thread's checkout so syncing a checkout never touches them and a drive
 * never saves them. They sit on the machine's own disk, which survives every
 * stop, so they carry over between turns and wakes; the disk is only ever a
 * cache, and a new machine starts cold.
 *
 * - Package-manager stores and download caches live in `caches/<toolchain>`,
 *   one directory per toolchain (OS, libc, architecture, Node major), so a
 *   machine on a new image never reuses what another toolchain built. They
 *   are content-addressed, so threads and lockfiles share them safely. The
 *   harnesses and the dependency step (`RunnerDependencies.ts`) both see
 *   them through `environment`.
 * - Dependency trees (`node_modules`) stay where Node resolves them, in the
 *   checkout, keyed on lockfile and toolchain by `RunnerDependencies.ts`.
 *   They are hardlinked from the store on the same disk, so a rebuild from a
 *   warm store downloads nothing.
 */

export interface MachineCaches {
  /** `linux-x64-glibc2.36-node24`: what a cache built here can run on. */
  readonly toolchain: string;
  /** This toolchain's stores and download caches. */
  readonly directory: string;
  /** Variables the harnesses and installs see, pointing every tool at `directory`. */
  readonly environment: Readonly<Record<string, string>>;
  /**
   * Takes `directory` out of the way at once and deletes it in the background,
   * so dropping a large dependency tree never holds up a turn.
   */
  readonly discard: (directory: string) => Effect.Effect<void, PlatformError.PlatformError>;
}

/** OS, libc, architecture and Node's major version (its native module ABI). */
const machineToolchain = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const report = process.report?.getReport() as
    | { readonly header?: { readonly glibcVersionRuntime?: string } }
    | undefined;
  const glibc = report?.header?.glibcVersionRuntime;
  const libc = glibc === undefined ? [] : [`glibc${glibc}`];
  const node = `node${process.versions.node.split(".")[0]}`;
  return [platform, arch, ...libc, node].join("-");
});

/**
 * The caches under `home`, made if missing. Lives as long as the scope, which
 * finishes deleting what was discarded. Trash a crash left behind, and the
 * caches of toolchains this machine no longer runs, are deleted in the
 * background.
 */
export const makeMachineCaches = Effect.fn("makeMachineCaches")(function* (
  home: string,
  toolchainOverride?: string,
) {
  const toolchain = toolchainOverride ?? (yield* machineToolchain);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const root = path.join(home, "caches");
  const directory = path.join(root, toolchain);
  // On the same disk as the checkouts, so discarding is a rename.
  const trash = path.join(root, "trash");
  const environment = {
    // Electron, Playwright, node-gyp headers and most other tools' download caches.
    XDG_CACHE_HOME: path.join(directory, "xdg"),
    npm_config_cache: path.join(directory, "npm"),
    pnpm_config_store_dir: path.join(directory, "pnpm-store"),
    COREPACK_HOME: path.join(directory, "corepack"),
    // Corepack asks before fetching the project's pnpm or yarn, and nobody is there to answer.
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* fs.makeDirectory(trash, { recursive: true });

  /** Deletes `target` in a low-priority `rm`, so gigabytes of files never crowd the turn's I/O. */
  const remove = (target: string) =>
    spawner
      .spawn(
        ChildProcess.make("nice", ["-n", "19", "rm", "-rf", "--", target], { stdin: "ignore" }),
      )
      .pipe(
        Effect.flatMap((child) => child.exitCode),
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.logWarning("could not delete discarded cache", {
            target,
            cause: Cause.pretty(cause),
          }),
        ),
      );

  let discarded = 0;
  const park = (target: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const parked = path.join(trash, `${now}-${process.pid}-${++discarded}`);
      yield* fs.rename(target, parked);
      return parked;
    });

  const discard = (target: string) =>
    park(target).pipe(
      Effect.flatMap((parked) => remove(parked).pipe(Effect.forkIn(scope))),
      Effect.asVoid,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.void,
      ),
    );

  yield* Effect.gen(function* () {
    for (const entry of yield* fs.readDirectory(root)) {
      if (entry !== toolchain && entry !== "trash") yield* park(path.join(root, entry));
    }
    for (const entry of yield* fs.readDirectory(trash)) yield* remove(path.join(trash, entry));
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("could not clear old caches", Cause.pretty(cause)),
    ),
    Effect.forkIn(scope),
  );

  return { toolchain, directory, environment, discard } satisfies MachineCaches;
});
