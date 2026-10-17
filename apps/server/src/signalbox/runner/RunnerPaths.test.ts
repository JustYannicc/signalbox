// @effect-diagnostics nodeBuiltinImport:off - the test creates and inspects real temporary paths.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { prepareRunnerPaths, runnerPaths } from "./RunnerPaths.ts";

describe("RunnerPaths", () => {
  it.effect("keeps safe IDs in place and moves saved machine state for colon IDs", () =>
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
      yield* fs.writeFileString(path.join(legacyMachine, "codex", "state_5.sqlite"), "stale index");

      const normal = runnerPaths(path, home, "thread-1");
      expect(normal.cwd).toBe(path.join(home, "workspaces", "thread-1", "drive"));

      const migrated = yield* prepareRunnerPaths(home, legacyId);
      expect(path.relative(home, migrated.cwd)).not.toContain(":");
      expect(path.relative(home, migrated.machineRoot)).not.toContain(":");
      expect(migrated.legacyCwd).toBe(path.join(legacyWorkspace, "drive"));
      expect(yield* fs.exists(legacyWorkspace)).toBe(false);
      expect(yield* fs.exists(legacyMachine)).toBe(false);
      expect(yield* fs.readFileString(path.join(migrated.workspaceRoot, "AGENTS.md"))).toBe(
        "folder instructions",
      );
      expect(yield* fs.readFileString(path.join(migrated.machineRoot, "home", "state.json"))).toBe(
        "saved home",
      );
      expect(yield* fs.exists(path.join(migrated.machineRoot, "codex", "state_5.sqlite"))).toBe(
        false,
      );

      expect((yield* prepareRunnerPaths(home, legacyId)).cwd).toBe(migrated.cwd);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
