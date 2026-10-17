// @effect-diagnostics nodeBuiltinImport:off - verifies real supervised subprocesses in an isolated Git checkout.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { snapshot, status, stop } from "@t3tools/shared/agentProcesses";

const command = NodeURL.fileURLToPath(
  new URL("../packages/shared/src/agentProcesses/cli.ts", import.meta.url),
);
const execute = NodeUtil.promisify(NodeChildProcess.execFile);

it("runs cleanup commands without installed application dependencies", async () => {
  const cwd = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "signalbox-cleanup-no-deps-")),
  );
  const sourceRoot = new URL("../", import.meta.url);
  try {
    await execute("git", ["init", "--quiet", cwd]);
    await NodeFSP.writeFile(NodePath.join(cwd, "package.json"), '{"type":"module"}');
    const files = [
      "packages/shared/package.json",
      "packages/shared/src/agentProcessSessions.ts",
      "packages/shared/src/agentProcesses",
    ];
    await Promise.all(
      files.map(async (file) => {
        const destination = NodePath.join(cwd, file);
        await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
        await NodeFSP.cp(new URL(file, sourceRoot), destination, { recursive: true });
      }),
    );
    const result = await execute(
      process.execPath,
      ["packages/shared/src/agentProcesses/cli.ts", "status"],
      {
        cwd,
      },
    );
    expect(JSON.parse(result.stdout)).toEqual([]);
    const tracked = await execute(
      process.execPath,
      [
        "packages/shared/src/agentProcesses/cli.ts",
        "run",
        "--session-id",
        "no-dependencies-fixture",
        "--",
        process.execPath,
        "-e",
        "process.stdout.write('tracked')",
      ],
      { cwd },
    );
    expect(tracked.stdout).toContain("tracked");
    const outside = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "signalbox-external-child-"),
    );
    try {
      const external = await execute(
        process.execPath,
        [
          "--import",
          NodePath.join(cwd, "packages/shared/src/agentProcesses/preload.ts"),
          "-e",
          "process.stdout.write('outside')",
        ],
        {
          cwd: outside,
          env: {
            ...process.env,
            SIGNALBOX_PROCESS_WORKTREE: cwd,
            SIGNALBOX_PROCESS_SESSION_ID: "outside-child",
            SIGNALBOX_PROCESS_OWNER_PID: String(process.pid),
          },
        },
      );
      expect(external.stdout).toBe("outside");
    } finally {
      await NodeFSP.rm(outside, { recursive: true, force: true });
    }
  } finally {
    await NodeFSP.rm(cwd, { recursive: true, force: true });
  }
});

it.effect.each([undefined, "codex-child-runtime"])(
  "binds a Codex command and its descendants to their own session hooks with agent ID %s",
  (agentId) =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      yield* Effect.promise(async () => {
        const cwd = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "signalbox-process-command-"),
        );
        await execute("git", ["init", "--quiet", cwd]);
        const sessionId = "integration-owned-session";
        const ownedId = agentId === undefined ? sessionId : `${sessionId}/${agentId}`;
        const environment: NodeJS.ProcessEnv = {
          ...process.env,
          CODEX_THREAD_ID: agentId ?? sessionId,
          CODEX_SESSION_ID: sessionId,
        };
        delete environment.SIGNALBOX_PROCESS_SESSION_ID;
        delete environment.CLAUDE_ENV_FILE;
        const hook = (hook_event_name: string) =>
          new Promise<void>((resolve, reject) => {
            const child = NodeChildProcess.spawn(process.execPath, [command, "hook"], {
              cwd,
              env: environment,
              stdio: ["pipe", "pipe", "pipe"],
            });
            let error = "";
            let output = "";
            child.stderr.on("data", (chunk) => {
              error += String(chunk);
            });
            child.stdout.on("data", (chunk) => {
              output += String(chunk);
            });
            child.once("error", reject);
            child.once("exit", (code) => {
              if (code !== 0) return reject(new Error(error));
              try {
                JSON.parse(output);
                resolve();
              } catch (error) {
                reject(error);
              }
            });
            child.stdin.end(
              JSON.stringify({
                cwd,
                session_id: sessionId,
                hook_event_name,
                ...(agentId === undefined ? {} : { agent_id: agentId }),
              }),
            );
          });
        const descendant =
          "console.log(JSON.stringify({ready:process.pid})); setInterval(()=>{},1000)";
        const source = `
    import { spawn } from 'node:child_process';
    spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'inherit'});
    setInterval(()=>{},1000);
  `;
        let wrapper: NodeChildProcess.ChildProcess | undefined;
        let wrapperExit: Promise<number | null> | undefined;
        try {
          await hook(agentId === undefined ? "SessionStart" : "SubagentStart");
          wrapper = NodeChildProcess.spawn(
            process.execPath,
            [command, "run", "--", process.execPath, "--input-type=module", "-e", source],
            { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] },
          );
          wrapperExit = new Promise((resolve, reject) => {
            wrapper!.once("error", reject);
            wrapper!.once("exit", resolve);
          });
          let stderr = "";
          wrapper.stderr!.on("data", (chunk) => {
            stderr += String(chunk);
          });
          const lines = NodeReadline.createInterface({ input: wrapper.stdout! });
          const ready = new Promise<void>((resolve, reject) => {
            lines.on("line", (line) => {
              if (line.startsWith('{"ready":')) resolve();
            });
            lines.once("close", () =>
              reject(new Error(`Tracked command exited before readiness: ${stderr}`)),
            );
          });
          await ready;
          const records = await snapshot({ worktreePath: cwd });
          expect(records.length).toBeGreaterThanOrEqual(2);
          expect(
            records.every(
              (record) => record.sessionId === ownedId && record.ownerPid === wrapper!.pid,
            ),
          ).toBe(true);
          const running = (await status({ worktreePath: cwd })).filter(
            (entry) => entry.state === "running",
          );
          expect(running.length).toBeGreaterThanOrEqual(2);
          expect(
            running.every(
              (entry) => entry.cpuPercent !== undefined && entry.rssBytes !== undefined,
            ),
          ).toBe(true);
          await hook(agentId === undefined ? "SessionEnd" : "SubagentStop");
          await wrapperExit;
          expect(
            (await status({ worktreePath: cwd })).some((entry) => entry.state === "running"),
          ).toBe(false);
          lines.close();
        } finally {
          await stop(cwd, { sessionId: ownedId, graceMs: 100 });
          if (wrapperExit !== undefined) await wrapperExit;
          await NodeFSP.rm(cwd, { recursive: true, force: true });
        }
      });
    }),
);
