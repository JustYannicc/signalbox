// @effect-diagnostics nodeBuiltinImport:off - verifies launch failure cleanup against a real subprocess.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { createNodeProcessOps } from "../../packages/shared/src/agentProcesses/processOps.ts";
import { runTrackedCommand } from "./agent-process-run.ts";

it.effect("waits for its spawned command to exit when registration fails", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    yield* Effect.promise(async () => {
      const cwd = await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "signalbox-launch-failure-")),
      );
      await NodeUtil.promisify(NodeChildProcess.execFile)("git", ["init", "--quiet", cwd]);
      let pid: number | undefined;
      try {
        await expect(
          runTrackedCommand(
            {
              cwd,
              worktreePath: cwd,
              command: process.execPath,
              args: ["-e", "setInterval(()=>{},1000)"],
            },
            async (registration) => {
              pid = registration.pid;
              throw new Error("registration unavailable");
            },
          ),
        ).rejects.toThrow("registration unavailable");
        expect(pid).toBeDefined();
        expect((await createNodeProcessOps().inspect(pid!)).state).toBe("missing");
      } finally {
        await NodeFSP.rm(cwd, { recursive: true, force: true });
      }
    });
  }),
);
