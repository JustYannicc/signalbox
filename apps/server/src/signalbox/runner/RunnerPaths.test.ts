// @effect-diagnostics nodeBuiltinImport:off - the test creates and inspects real temporary paths.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  prepareRunnerPaths,
  runnerPaths,
  RunnerPathMigrationConflictError,
  RunnerPathsHomeError,
} from "./RunnerPaths.ts";

describe("RunnerPaths", () => {
  it.effect(
    "moves colon IDs before Codex indexes can retain old paths and keeps legacy aliases",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const legacyId = "thread:0123456789abcdef";
        const legacyWorkspace = path.join(home, "workspaces", legacyId);
        const legacyMachine = path.join(home, "machines", legacyId);
        yield* fs.makeDirectory(path.join(legacyWorkspace, "drive"), { recursive: true });
        yield* fs.makeDirectory(path.join(legacyMachine, "home"), { recursive: true });
        yield* fs.makeDirectory(path.join(legacyMachine, "codex"), { recursive: true });
        yield* fs.writeFileString(path.join(legacyWorkspace, "AGENTS.md"), "folder instructions");
        yield* fs.writeFileString(path.join(legacyMachine, "home", "state.json"), "saved home");
        yield* fs.writeFileString(
          path.join(legacyMachine, "codex", "state_5.sqlite"),
          "stale index",
        );

        const normal = runnerPaths(path, home, "thread-1");
        expect(normal.cwd).toBe(path.join(home, "workspaces", "thread-1", "drive"));

        let sawCleanIndexesAtRename = false;
        const realRename = fs.rename;
        const observingFs = {
          ...fs,
          rename: (from: string, to: string) =>
            Effect.gen(function* () {
              if (from === legacyMachine) {
                sawCleanIndexesAtRename = !(yield* fs.exists(
                  path.join(legacyMachine, "codex", "state_5.sqlite"),
                ));
              }
              yield* realRename(from, to);
            }),
        };
        const migrated = yield* prepareRunnerPaths(home, legacyId).pipe(
          Effect.provideService(FileSystem.FileSystem, observingFs),
        );
        expect(sawCleanIndexesAtRename).toBe(true);
        expect(path.relative(home, migrated.cwd)).not.toContain(":");
        expect(path.relative(home, migrated.machineRoot)).not.toContain(":");
        expect(migrated.workspaceRoot).toContain(
          path.join("encoded", Base64Url.encode(new TextEncoder().encode(legacyId))),
        );
        expect(migrated.legacyCwd).toBe(path.join(legacyWorkspace, "drive"));
        expect(yield* fs.readLink(legacyWorkspace)).toBe(migrated.workspaceRoot);
        expect(yield* fs.readLink(legacyMachine)).toBe(migrated.machineRoot);
        expect(yield* fs.realPath(migrated.legacyCwd!)).toBe(yield* fs.realPath(migrated.cwd));
        expect(yield* fs.readFileString(path.join(legacyWorkspace, "AGENTS.md"))).toBe(
          "folder instructions",
        );
        expect(yield* fs.readFileString(path.join(migrated.workspaceRoot, "AGENTS.md"))).toBe(
          "folder instructions",
        );
        expect(
          yield* fs.readFileString(path.join(migrated.machineRoot, "home", "state.json")),
        ).toBe("saved home");
        expect(yield* fs.exists(path.join(migrated.machineRoot, "codex", "state_5.sqlite"))).toBe(
          false,
        );

        yield* fs.writeFileString(
          path.join(migrated.machineRoot, "codex", "state_5.sqlite"),
          "rebuilt index",
        );
        expect((yield* prepareRunnerPaths(home, legacyId)).cwd).toBe(migrated.cwd);
        expect(
          yield* fs.readFileString(path.join(migrated.machineRoot, "codex", "state_5.sqlite")),
        ).toBe("rebuilt index");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("creates transcript path aliases before restoring onto an empty machine", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const threadId = "thread:fresh-machine";
      const planned = runnerPaths(path, home, threadId);
      expect(yield* fs.exists(planned.workspaceRoot)).toBe(false);
      expect(yield* fs.exists(planned.machineRoot)).toBe(false);
      expect(yield* fs.exists(planned.legacyWorkspaceRoot!)).toBe(false);
      expect(yield* fs.exists(planned.legacyMachineRoot!)).toBe(false);

      const fresh = yield* prepareRunnerPaths(home, threadId);
      expect(yield* fs.readLink(fresh.legacyWorkspaceRoot!)).toBe(fresh.workspaceRoot);
      expect(yield* fs.readLink(fresh.legacyMachineRoot!)).toBe(fresh.machineRoot);

      // The drive store restores files after path preparation; old transcript paths must already resolve.
      const restoredFile = path.join(fresh.cwd, "src", "main.ts");
      yield* fs.makeDirectory(path.dirname(restoredFile), { recursive: true });
      yield* fs.writeFileString(restoredFile, "restored source");
      expect(yield* fs.readFileString(path.join(fresh.legacyCwd!, "src", "main.ts"))).toBe(
        "restored source",
      );

      const index = path.join(fresh.machineRoot, "codex", "state_5.sqlite");
      yield* fs.makeDirectory(path.dirname(index), { recursive: true });
      yield* fs.writeFileString(index, "valid index");
      expect((yield* prepareRunnerPaths(home, threadId)).cwd).toBe(fresh.cwd);
      expect(yield* fs.readFileString(index)).toBe("valid index");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("repairs a prior rename that left stale Codex indexes and no alias", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const threadId = "thread:partial-migration";
      const current = runnerPaths(path, home, threadId);
      const staleIndex = path.join(current.machineRoot, "codex", "thread_history_1.sqlite");
      yield* fs.makeDirectory(path.join(current.workspaceRoot, "drive"), { recursive: true });
      yield* fs.makeDirectory(path.join(current.machineRoot, "home"), { recursive: true });
      yield* fs.makeDirectory(path.join(current.machineRoot, "codex"), { recursive: true });
      yield* fs.writeFileString(path.join(current.machineRoot, "home", "saved.json"), "state");
      yield* fs.writeFileString(staleIndex, "stale index");

      const repaired = yield* prepareRunnerPaths(home, threadId);
      expect(yield* fs.readLink(repaired.legacyWorkspaceRoot!)).toBe(repaired.workspaceRoot);
      expect(yield* fs.readLink(repaired.legacyMachineRoot!)).toBe(repaired.machineRoot);
      expect(yield* fs.readFileString(path.join(repaired.machineRoot, "home", "saved.json"))).toBe(
        "state",
      );
      expect(yield* fs.exists(staleIndex)).toBe(false);
      expect((yield* prepareRunnerPaths(home, threadId)).cwd).toBe(repaired.cwd);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps divergent roots intact and reports a recoverable conflict", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const threadId = "thread:diverged";
      const current = runnerPaths(path, home, threadId);
      const legacyWorkspace = current.legacyWorkspaceRoot!;
      yield* fs.makeDirectory(path.join(legacyWorkspace, "drive"), { recursive: true });
      yield* fs.makeDirectory(path.join(current.workspaceRoot, "drive"), { recursive: true });
      yield* fs.writeFileString(path.join(legacyWorkspace, "legacy.txt"), "legacy");
      yield* fs.writeFileString(path.join(current.workspaceRoot, "current.txt"), "current");
      yield* fs.makeDirectory(path.join(current.legacyMachineRoot!, "home"), { recursive: true });
      yield* fs.makeDirectory(path.join(current.machineRoot, "home"), { recursive: true });
      yield* fs.writeFileString(
        path.join(current.legacyMachineRoot!, "home", "legacy.json"),
        "legacy machine",
      );
      yield* fs.writeFileString(
        path.join(current.machineRoot, "home", "current.json"),
        "current machine",
      );

      const error = yield* Effect.flip(prepareRunnerPaths(home, threadId));
      expect(error).toBeInstanceOf(RunnerPathMigrationConflictError);
      expect(error).toMatchObject({
        threadId,
        legacyPath: legacyWorkspace,
        currentPath: current.workspaceRoot,
      });
      expect(yield* fs.readFileString(path.join(legacyWorkspace, "legacy.txt"))).toBe("legacy");
      expect(yield* fs.readFileString(path.join(current.workspaceRoot, "current.txt"))).toBe(
        "current",
      );
      expect(
        yield* fs.readFileString(path.join(current.legacyMachineRoot!, "home", "legacy.json")),
      ).toBe("legacy machine");
      expect(yield* fs.readFileString(path.join(current.machineRoot, "home", "current.json"))).toBe(
        "current machine",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a foreign legacy alias without touching either tree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const threadId = "thread:foreign-alias";
      const current = runnerPaths(path, home, threadId);
      const legacyWorkspace = current.legacyWorkspaceRoot!;
      const foreignRoot = path.join(home, "workspaces", "another-thread");
      yield* fs.makeDirectory(foreignRoot, { recursive: true });
      yield* fs.makeDirectory(current.workspaceRoot, { recursive: true });
      yield* fs.writeFileString(path.join(foreignRoot, "foreign.txt"), "foreign data");
      yield* fs.writeFileString(path.join(current.workspaceRoot, "current.txt"), "current data");
      yield* fs.symlink(foreignRoot, legacyWorkspace);

      const error = yield* Effect.flip(prepareRunnerPaths(home, threadId));
      expect(error).toBeInstanceOf(RunnerPathMigrationConflictError);
      expect(error).toMatchObject({ threadId, legacyPath: legacyWorkspace });
      expect(yield* fs.readLink(legacyWorkspace)).toBe(foreignRoot);
      expect(yield* fs.readFileString(path.join(legacyWorkspace, "foreign.txt"))).toBe(
        "foreign data",
      );
      expect(yield* fs.readFileString(path.join(current.workspaceRoot, "current.txt"))).toBe(
        "current data",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a host root that would put a colon back in PWD and HOME", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const home = path.join(root, "home:colon");
      const error = yield* Effect.flip(prepareRunnerPaths(home, "thread:unsafe"));
      expect(error).toBeInstanceOf(RunnerPathsHomeError);
      expect(error).toMatchObject({ home, threadId: "thread:unsafe" });
      expect(yield* fs.exists(home)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the Windows PATH-list separator for the home check", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const home = path.join(root, "C:runner");
      const paths = yield* prepareRunnerPaths(home, "thread-safe").pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
      );
      expect(paths.cwd).toContain("C:runner");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects the Windows PATH-list separator in the Runner home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const home = path.join(root, "runner;path");
      const error = yield* Effect.flip(
        prepareRunnerPaths(home, "thread-safe").pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
        ),
      );
      expect(error).toBeInstanceOf(RunnerPathsHomeError);
      expect(error).toMatchObject({ home, threadId: "thread-safe" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
