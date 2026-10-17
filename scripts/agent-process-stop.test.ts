// @effect-diagnostics nodeBuiltinImport:off - verifies session isolation with fixture subprocesses.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { registerProcess, snapshot } from "../packages/shared/src/agentProcesses/registry.ts";
import { createNodeProcessOps } from "../packages/shared/src/agentProcesses/processOps.ts";
import { recordSession } from "../packages/shared/src/agentProcessSessions.ts";

const command = NodeURL.fileURLToPath(new URL("./agent-processes.ts", import.meta.url));
const execute = NodeUtil.promisify(NodeChildProcess.execFile);

it.effect("stops only the selected session unless every registration is explicitly requested", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    yield* Effect.promise(async () => {
      const cwd = await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "signalbox-shared-session-stop-")),
      );
      const children: Array<{ child: NodeChildProcess.ChildProcess; exited: Promise<void> }> = [];
      const environment = { ...process.env };
      delete environment.SIGNALBOX_PROCESS_SESSION_ID;
      delete environment.CODEX_THREAD_ID;
      delete environment.CODEX_SESSION_ID;
      const processOps = createNodeProcessOps();
      try {
        await execute("git", ["init", "--quiet", cwd]);
        for (const sessionId of ["agent-session", "developer-session"]) {
          const child = NodeChildProcess.spawn(
            process.execPath,
            ["-e", "setInterval(()=>{},1000)"],
            {
              cwd,
              stdio: "ignore",
            },
          );
          const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
          children.push({ child, exited });
          await new Promise<void>((resolve, reject) => {
            child.once("spawn", resolve);
            child.once("error", reject);
          });
          if (child.pid === undefined) throw new Error("Fixture child has no PID");
          await registerProcess({ worktreePath: cwd, pid: child.pid, sessionId });
        }
        const [agent, developer] = children;
        await expect(
          execute(process.execPath, [command, "stop"], { cwd, env: environment }),
        ).rejects.toThrow("Stopping processes requires --session-id");
        expect((await processOps.inspect(agent!.child.pid!)).state).toBe("running");
        expect((await processOps.inspect(developer!.child.pid!)).state).toBe("running");

        await recordSession(cwd, "agent-session", false, "agent-session");
        await expect(
          execute(process.execPath, [command, "stop"], {
            cwd,
            env: { ...environment, SIGNALBOX_PROCESS_SESSION_ID: "agent-session" },
          }),
        ).rejects.toThrow("Stopping processes requires --session-id");
        expect((await processOps.inspect(agent!.child.pid!)).state).toBe("running");
        expect((await processOps.inspect(developer!.child.pid!)).state).toBe("running");
        const unboundChild = await execute(process.execPath, [command, "stop"], {
          cwd,
          env: {
            ...environment,
            CODEX_THREAD_ID: "unbound-child",
            CODEX_SESSION_ID: "agent-session",
          },
        });
        expect(JSON.parse(unboundChild.stdout).candidates).toEqual([]);
        expect((await processOps.inspect(agent!.child.pid!)).state).toBe("running");
        expect((await processOps.inspect(developer!.child.pid!)).state).toBe("running");
        await expect(
          execute(process.execPath, [command, "stop"], {
            cwd,
            env: { ...environment, CODEX_SESSION_ID: "agent-session" },
          }),
        ).rejects.toThrow("Stopping processes requires --session-id");

        await recordSession(cwd, "agent-session/claude-child", false, "claude-child");
        const inherited = { ...environment, SIGNALBOX_PROCESS_SESSION_ID: "agent-session" };
        await expect(
          execute(process.execPath, [command, "stop"], { cwd, env: inherited }),
        ).rejects.toThrow("Stopping processes requires --session-id");
        const marker = NodePath.join(cwd, "ambiguous-command-started");
        await expect(
          execute(
            process.execPath,
            [
              command,
              "run",
              "--",
              process.execPath,
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started')`,
            ],
            {
              cwd,
              env: inherited,
            },
          ),
        ).rejects.toThrow("Inherited session ownership is ambiguous");
        await expect(NodeFSP.access(marker)).rejects.toThrow();
        expect((await processOps.inspect(agent!.child.pid!)).state).toBe("running");
        expect((await processOps.inspect(developer!.child.pid!)).state).toBe("running");
        await recordSession(cwd, "agent-session/claude-child", true, "claude-child");

        await execute(process.execPath, [command, "stop", "--session-id", "agent-session"], {
          cwd,
          env: { ...environment, SIGNALBOX_PROCESS_SESSION_ID: "agent-session" },
        });
        await agent!.exited;
        expect((await processOps.inspect(developer!.child.pid!)).state).toBe("running");

        await expect(
          execute(
            process.execPath,
            [command, "stop", "--session-id", "developer-session", "--all"],
            {
              cwd,
              env: environment,
            },
          ),
        ).rejects.toThrow("Choose --session-id or --all, not both");
        expect((await processOps.inspect(developer!.child.pid!)).state).toBe("running");

        await execute(process.execPath, [command, "stop", "--all"], { cwd, env: environment });
        await developer!.exited;
        expect(await snapshot({ worktreePath: cwd })).toEqual([]);
      } finally {
        for (const { child, exited } of children) {
          if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await exited;
          }
        }
        await NodeFSP.rm(cwd, { recursive: true, force: true });
      }
    });
  }),
);
