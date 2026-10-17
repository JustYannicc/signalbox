// @effect-diagnostics nodeBuiltinImport:off - Tests cleanup with real subprocesses and worktrees.
import { expect, it } from "vite-plus/test";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "../HostProcess.ts";
import { createAgentProcessRegistry } from "./registry.ts";
import { makeFixture } from "./test-fixture.ts";

it("does not escalate after its session has resumed", async () => {
  const { worktreePath, commonDir, registry, signals, waits, addProcess, setTerminateOnSignal } =
    makeFixture();
  addProcess(50_007);
  await registry.registerProcess({ worktreePath, pid: 50_007, sessionId: "session-resume" });
  setTerminateOnSignal(false);
  waits.push(() => {});
  let statusReads = 0;
  let checkedWorktreePath: string | undefined;

  const result = await registry.reap({
    commonDir,
    finishedSessionIds: ["session-resume"],
    isSessionEnded: async (_sessionId, sessionWorktreePath) => {
      checkedWorktreePath = sessionWorktreePath;
      return ++statusReads < 3;
    },
    graceMs: 1,
    print: () => {},
  });

  expect(signals).toEqual([{ pid: 50_007, signal: "SIGTERM" }]);
  expect(result.survivors).toEqual([
    expect.objectContaining({ pid: 50_007, reason: "owning session resumed before SIGKILL" }),
  ]);
  expect(checkedWorktreePath).toBe(worktreePath);
  expect(await registry.snapshot({ worktreePath })).toHaveLength(1);
});

it("reaps processes whose recorded owner identity has ended", async () => {
  const { worktreePath, commonDir, registry, signals, processes, addProcess } = makeFixture();
  addProcess(51_001);
  addProcess(51_002);
  addProcess(52_001);
  addProcess(52_002);
  await registry.registerProcess({ worktreePath, pid: 51_001, ownerPid: 52_001, sessionId: "old" });
  await registry.registerProcess({
    worktreePath,
    pid: 51_002,
    ownerPid: 52_002,
    sessionId: "active",
  });
  processes.delete(52_001);

  const result = await registry.reap({ commonDir, print: () => {}, graceMs: 0 });

  expect(result.considered).toBe(1);
  expect(signals).toEqual([{ pid: 51_001, signal: "SIGTERM" }]);
  expect(await registry.snapshot({ worktreePath })).toMatchObject([
    { pid: 51_002, ownerPid: 52_002, sessionId: "active" },
  ]);
});

it("uses finished session IDs when no live session check is available", async () => {
  const { worktreePath, commonDir, registry, signals, addProcess } = makeFixture();
  addProcess(51_003);
  await registry.registerProcess({ worktreePath, pid: 51_003, sessionId: "finished" });

  const result = await registry.reap({
    commonDir,
    finishedSessionIds: ["finished"],
    print: () => {},
    graceMs: 0,
  });

  expect(result.considered).toBe(1);
  expect(signals).toEqual([{ pid: 51_003, signal: "SIGTERM" }]);
  expect(await registry.snapshot({ worktreePath })).toEqual([]);
});

it("reports process metrics for validated registered PIDs", async () => {
  const { worktreePath, registry, addProcess, metrics } = makeFixture();
  addProcess(50_008);
  metrics.set(50_008, { cpuPercent: 4.5, rssBytes: 1_048_576, listeningPorts: [43123] });
  await registry.registerProcess({ worktreePath, pid: 50_008, ports: [43123] });

  expect(await registry.status({ worktreePath })).toMatchObject([
    {
      state: "running",
      cpuPercent: 4.5,
      rssBytes: 1_048_576,
      listeningPorts: [43123],
    },
  ]);
});

it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "reports an exited native child without leaving it as a stop survivor",
  async () => {
    const { worktreePath, commonDir } = makeFixture();
    const child = NodeChildProcess.spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
      { cwd: worktreePath, stdio: "ignore" },
    );
    try {
      await new Promise<void>((resolve) => child.once("spawn", resolve));
      if (child.pid === undefined) throw new Error("test child has no pid");
      const registry = createAgentProcessRegistry({ commonDirResolver: () => commonDir });
      await registry.registerProcess({ worktreePath, pid: child.pid, label: "test child" });
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await exited;

      expect(await registry.status({ worktreePath })).toMatchObject([
        { process: { pid: child.pid }, state: "exited" },
      ]);
      const stopped = await registry.stop(worktreePath, { graceMs: 0, print: () => {} });
      expect(stopped.survivors).toEqual([]);
      expect(stopped.removed).toEqual([child.pid]);
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
    }
  },
);

it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "keeps a live process with an unverifiable deleted cwd as a survivor",
  async () => {
    const { worktreePath, commonDir } = makeFixture();
    const child = NodeChildProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: worktreePath,
      stdio: "ignore",
    });
    try {
      await new Promise<void>((resolve) => child.once("spawn", resolve));
      if (child.pid === undefined) throw new Error("test child has no pid");
      const registry = createAgentProcessRegistry({ commonDirResolver: () => commonDir });
      await registry.registerProcess({
        worktreePath,
        pid: child.pid,
        sessionId: "deleted-worktree",
      });
      await NodeFSP.rm(worktreePath, { recursive: true, force: true });

      const result = await registry.reap({ commonDir, print: () => {} });

      expect(result.survivors).toEqual([expect.objectContaining({ pid: child.pid })]);
      expect(child.exitCode).toBeNull();
    } finally {
      if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await exited;
      }
    }
  },
);
