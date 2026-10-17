import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CODEX_ROLLOUT_INDEXES } from "./RunnerMachineFolders.ts";

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
const LEGACY_THREAD_ID = /^[A-Za-z0-9:_-]+$/;

type DirectoryState =
  | { readonly _tag: "None" }
  | { readonly _tag: "Alias" }
  | { readonly _tag: "Legacy" }
  | { readonly _tag: "Current" };

export class RunnerPathsHomeError extends Schema.TaggedError<RunnerPathsHomeError>()(
  "RunnerPathsHomeError",
  { home: Schema.String, threadId: Schema.String },
) {
  override get message(): string {
    return "The Runner home path contains the host PATH-list separator.";
  }
}

export class RunnerPathMigrationConflictError extends Schema.TaggedError<RunnerPathMigrationConflictError>()(
  "RunnerPathMigrationConflictError",
  {
    threadId: Schema.String,
    legacyPath: Schema.String,
    currentPath: Schema.String,
  },
) {
  override get message(): string {
    return `Saved Runner paths conflict for thread ${this.threadId}; no path was changed.`;
  }
}

export interface RunnerPaths {
  /** The directory above the drive checkout, where generated folder instructions live. */
  readonly workspaceRoot: string;
  /** The drive checkout itself. */
  readonly cwd: string;
  /** The per-thread home and harness settings. */
  readonly machineRoot: string;
  /** The old checkout path, used to update Codex's saved session metadata. */
  readonly legacyCwd?: string;
  readonly legacyWorkspaceRoot?: string;
  readonly legacyMachineRoot?: string;
}

const threadPathSegments = (threadId: string): ReadonlyArray<string> =>
  SAFE_PATH_SEGMENT.test(threadId)
    ? [threadId]
    : ["encoded", Base64Url.encode(new TextEncoder().encode(threadId))];

/** Stable per-thread directories. Generated thread IDs may contain `:`, which is PATH's separator. */
export const runnerPaths = (path: Path.Path, home: string, threadId: string): RunnerPaths => {
  const segments = threadPathSegments(threadId);
  const workspaceRoot = path.join(home, "workspaces", ...segments);
  const machineRoot = path.join(home, "machines", ...segments);
  const canMigrateLegacy = !SAFE_PATH_SEGMENT.test(threadId) && LEGACY_THREAD_ID.test(threadId);
  const legacyWorkspaceRoot = canMigrateLegacy
    ? path.join(home, "workspaces", threadId)
    : undefined;
  const legacyMachineRoot = canMigrateLegacy ? path.join(home, "machines", threadId) : undefined;

  return {
    workspaceRoot,
    cwd: path.join(workspaceRoot, "drive"),
    machineRoot,
    ...(legacyWorkspaceRoot === undefined
      ? {}
      : { legacyWorkspaceRoot, legacyCwd: path.join(legacyWorkspaceRoot, "drive") }),
    ...(legacyMachineRoot === undefined ? {} : { legacyMachineRoot }),
  };
};

/** Migrates unsafe legacy roots and keeps old absolute transcript paths working through aliases. */
export const prepareRunnerPaths = Effect.fn("prepareRunnerPaths")(function* (
  home: string,
  threadId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const pathListSeparator = platform === "win32" ? ";" : ":";
  if (home.includes(pathListSeparator)) {
    return yield* new RunnerPathsHomeError({ home, threadId });
  }
  const paths = runnerPaths(path, home, threadId);

  const conflict = (legacyPath: string, currentPath: string) =>
    new RunnerPathMigrationConflictError({ threadId, legacyPath, currentPath });

  const inspect = (legacy: string | undefined, current: string) =>
    Effect.gen(function* () {
      if (legacy === undefined) return { _tag: "None" } satisfies DirectoryState;

      const link = yield* Effect.exit(fs.readLink(legacy));
      const currentExists = yield* fs.exists(current);
      if (link._tag === "Success") {
        const target = path.resolve(path.dirname(legacy), link.value);
        if (target === current && currentExists) return { _tag: "Alias" } satisfies DirectoryState;
        return yield* conflict(legacy, current);
      }

      const legacyExists = yield* fs.exists(legacy);
      if (legacyExists && currentExists) return yield* conflict(legacy, current);
      if (legacyExists) return { _tag: "Legacy" } satisfies DirectoryState;
      if (currentExists) return { _tag: "Current" } satisfies DirectoryState;
      return { _tag: "None" } satisfies DirectoryState;
    });

  // Inspect both roots before moving either one, so a conflict never leaves a half-migrated pair.
  const workspaceState = yield* inspect(paths.legacyWorkspaceRoot, paths.workspaceRoot);
  const machineState = yield* inspect(paths.legacyMachineRoot, paths.machineRoot);
  const migrate = (
    legacy: string | undefined,
    current: string,
    state: DirectoryState,
    machine: boolean,
  ) =>
    Effect.gen(function* () {
      if (legacy === undefined || state._tag === "Alias") return;

      if (state._tag === "None") {
        // A fresh machine still needs old transcript paths to work after the drive is restored.
        yield* fs.makeDirectory(current, { recursive: true });
        yield* fs.makeDirectory(path.dirname(legacy), { recursive: true });
        yield* fs.symlink(current, legacy);
        return;
      }

      const root = state._tag === "Legacy" ? legacy : current;
      if (machine) {
        const codexHome = path.join(root, "codex");
        // Indexes contain absolute rollout paths; remove them before a root can move.
        yield* Effect.forEach(CODEX_ROLLOUT_INDEXES, (file) =>
          fs.remove(path.join(codexHome, file), { force: true }),
        );
      }

      if (state._tag === "Legacy") {
        yield* fs.makeDirectory(path.dirname(current), { recursive: true });
        yield* fs.rename(legacy, current);
      }
      yield* fs.makeDirectory(path.dirname(legacy), { recursive: true });
      yield* fs.symlink(current, legacy);
    });

  yield* migrate(paths.legacyWorkspaceRoot, paths.workspaceRoot, workspaceState, false);
  yield* migrate(paths.legacyMachineRoot, paths.machineRoot, machineState, true);
  return paths;
});
