// @effect-diagnostics nodeBuiltinImport:off - thread ids need a path-safe, collision-free encoding.
import * as NodeBuffer from "node:buffer";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { CODEX_ROLLOUT_INDEXES } from "./RunnerMachineFolders.ts";

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;
const LEGACY_THREAD_ID = /^[A-Za-z0-9:_-]+$/;

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
    : ["encoded", NodeBuffer.Buffer.from(threadId).toString("base64url")];

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

/** Moves a thread's local state once while keeping the remotely saved folder names unchanged. */
export const prepareRunnerPaths = Effect.fn("prepareRunnerPaths")(function* (
  home: string,
  threadId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const paths = runnerPaths(path, home, threadId);

  const moveLegacyDirectory = (legacy: string | undefined, current: string) =>
    Effect.gen(function* () {
      if (legacy === undefined || !(yield* fs.exists(legacy))) return false;
      if (yield* fs.exists(current)) {
        return yield* Effect.die(new Error("Both legacy and encoded Runner paths exist."));
      }
      yield* fs.makeDirectory(path.dirname(current), { recursive: true });
      yield* fs.rename(legacy, current);
      return true;
    });

  yield* moveLegacyDirectory(paths.legacyWorkspaceRoot, paths.workspaceRoot);
  const movedMachine = yield* moveLegacyDirectory(paths.legacyMachineRoot, paths.machineRoot);
  if (movedMachine) {
    const codexHome = path.join(paths.machineRoot, "codex");
    yield* Effect.forEach(CODEX_ROLLOUT_INDEXES, (file) =>
      fs.remove(path.join(codexHome, file), { force: true }),
    );
  }
  return paths;
});
