// @effect-diagnostics nodeBuiltinImport:off - Uses real temporary worktrees for persistence checks.
import { expect, it, vi } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { makeFixture } from "./test-fixture.ts";

it("registers a process in the worktree and durable common-dir index", async () => {
  const { worktreePath, commonDir, registry, addProcess } = makeFixture();
  addProcess(41_234);
  addProcess(40_000);

  const unregister = await registry.registerProcess({
    worktreePath,
    pid: 41_234,
    sessionId: "session-a",
    ports: [43121],
    label: "vite dev server",
    ownerPid: 40_000,
  });

  expect(await registry.snapshot({ worktreePath })).toMatchObject([
    {
      worktreePath,
      pid: 41_234,
      sessionId: "session-a",
      ports: [43121],
      label: "vite dev server",
      ownerPid: 40_000,
    },
  ]);
  expect(NodeFS.readdirSync(NodePath.join(worktreePath, ".t3", "agent-processes"))).toHaveLength(1);
  expect(
    NodeFS.readdirSync(NodePath.join(commonDir, "signalbox-agent-processes", "index")),
  ).toHaveLength(1);

  await unregister();

  expect(await registry.snapshot({ worktreePath })).toEqual([]);
  expect(NodeFS.readdirSync(NodePath.join(worktreePath, ".t3", "agent-processes"))).toEqual([]);
  expect(
    NodeFS.readdirSync(NodePath.join(commonDir, "signalbox-agent-processes", "index")),
  ).toEqual([]);
});

it("blocks registration while a worktree is closed and opens it after release", async () => {
  const { worktreePath, commonDir, registry, addProcess } = makeFixture();
  const registeredPid = process.pid === 41_237 ? 41_238 : 41_237;
  addProcess(process.pid);
  addProcess(registeredPid);
  const closure = await registry.closeWorktree(worktreePath);

  expect(closure.commonDir).toBe(commonDir);
  await expect(registry.registerProcess({ worktreePath, pid: registeredPid })).rejects.toThrow(
    "Worktree is already closed for cleanup",
  );
  expect(await registry.snapshot({ worktreePath })).toEqual([]);

  await closure.release();
  await closure.release();
  const unregister = await registry.registerProcess({ worktreePath, pid: registeredPid });
  await unregister();
});

it("does not let an old closure lease remove a newer gate", async () => {
  const { worktreePath, registry, processes, addProcess } = makeFixture();
  const registeredPid = process.pid === 41_239 ? 41_240 : 41_239;
  addProcess(process.pid);
  addProcess(registeredPid);
  const first = await registry.closeWorktree(worktreePath);
  const oldOwner = processes.get(process.pid);
  if (oldOwner === undefined) throw new Error("fixture owner process missing");
  processes.set(process.pid, {
    ...oldOwner,
    identity: { ...oldOwner.identity, startTime: "reused-owner" },
  });

  const second = await registry.closeWorktree(worktreePath);
  await first.release();
  await expect(registry.registerProcess({ worktreePath, pid: registeredPid })).rejects.toThrow(
    "Worktree is already closed for cleanup",
  );

  await second.release();
  const unregister = await registry.registerProcess({ worktreePath, pid: registeredPid });
  await unregister();
});

it("does not register a process after its closed worktree has been removed", async () => {
  const { worktreePath, registry, processOps, processes, addProcess } = makeFixture();
  const pid = 41_241;
  addProcess(process.pid);
  addProcess(pid);
  let resumeIdentity!: () => void;
  let signalIdentityWaiter!: () => void;
  const identityGate = new Promise<void>((resolve) => {
    resumeIdentity = resolve;
  });
  const identityWaiting = new Promise<void>((resolve) => {
    signalIdentityWaiter = resolve;
  });
  let pauseOnce = true;
  processOps.identify.mockImplementation(async (requestedPid) => {
    if (requestedPid === process.pid && pauseOnce) {
      pauseOnce = false;
      signalIdentityWaiter();
      await identityGate;
    }
    return processes.get(requestedPid)?.identity;
  });

  const registration = registry.registerProcess({ worktreePath, pid });
  await identityWaiting;
  const closure = await registry.closeWorktree(worktreePath);
  NodeFS.rmSync(worktreePath, { recursive: true, force: true });
  await closure.release();
  resumeIdentity();

  await expect(registration).rejects.toThrow("worktree is no longer available");
  expect(await registry.snapshot({ commonDir: closure.commonDir })).toEqual([]);
});

it("merges repeated registration metadata for the same process identity", async () => {
  const { worktreePath, registry, addProcess } = makeFixture();
  addProcess(41_235);

  const unregister = await registry.registerProcess({
    worktreePath,
    pid: 41_235,
    label: "web child",
    ports: [43121],
  });
  await registry.registerProcess({ worktreePath, pid: 41_235, ports: [43122] });

  expect(await registry.snapshot({ worktreePath })).toMatchObject([
    { pid: 41_235, label: "web child", ports: [43121, 43122] },
  ]);
  await unregister();
});

it("refuses a process whose cwd belongs to a nested checkout", async () => {
  const { worktreePath, registry, addProcess } = makeFixture();
  const nestedCheckout = NodePath.join(worktreePath, "vendor", "separate-worktree");
  NodeFS.mkdirSync(NodePath.join(nestedCheckout, ".git"), { recursive: true });
  addProcess(41_236, { cwd: nestedCheckout });

  await expect(registry.registerProcess({ worktreePath, pid: 41_236 })).rejects.toThrow(
    "outside its registered worktree",
  );
  expect(await registry.snapshot({ worktreePath })).toEqual([]);
});

it("stops only registered PIDs and prints the candidate list before signaling", async () => {
  const { worktreePath, registry, processOps, signals, events, addProcess } = makeFixture();
  addProcess(50_001);
  addProcess(50_002);
  await registry.registerProcess({
    worktreePath,
    pid: 50_001,
    sessionId: "session-a",
    label: "server",
  });

  let printed = "";
  const result = await registry.stop(worktreePath, {
    sessionId: "session-a",
    graceMs: 0,
    print: (text) => {
      events.push("printed");
      printed = text;
    },
  });

  expect(printed).toContain("pid=50001");
  expect(printed).not.toContain("pid=50002");
  expect(events[0]).toBe("printed");
  expect(signals).toEqual([{ pid: 50_001, signal: "SIGTERM" }]);
  expect(result.candidates).toEqual([50_001]);
  expect(result.stopped).toEqual([50_001]);
  expect(processOps.sendSignal).toHaveBeenCalledTimes(1);
});

it("does not print a candidate list when no process can be stopped", async () => {
  const { worktreePath, registry, signals } = makeFixture();
  const print = vi.fn();

  const result = await registry.stop(worktreePath, { print });

  expect(print).not.toHaveBeenCalled();
  expect(result.candidates).toEqual([]);
  expect(signals).toEqual([]);
});

it("awaits an asynchronous candidate printer before signaling", async () => {
  const { worktreePath, registry, signals, addProcess } = makeFixture();
  addProcess(50_003);
  await registry.registerProcess({ worktreePath, pid: 50_003 });

  let releasePrint!: () => void;
  const gate = new Promise<void>((resolve) => {
    releasePrint = resolve;
  });
  const stopping = registry.stop(worktreePath, { graceMs: 0, print: async () => gate });
  await Promise.resolve();
  expect(signals).toEqual([]);

  releasePrint();
  await stopping;

  expect(signals).toEqual([{ pid: 50_003, signal: "SIGTERM" }]);
});

it("ignores a reused PID even when its cwd is still the registered worktree", async () => {
  const { worktreePath, registry, signals, processes, addProcess } = makeFixture();
  addProcess(50_004);
  await registry.registerProcess({ worktreePath, pid: 50_004 });
  const current = processes.get(50_004);
  expect(current).toBeDefined();
  if (current === undefined) throw new Error("fixture process missing");
  processes.set(50_004, {
    ...current,
    identity: { ...current.identity, startTime: "reused-start" },
  });

  const result = await registry.stop(worktreePath, { graceMs: 0, print: () => {} });

  expect(signals).toEqual([]);
  expect(result.candidates).toEqual([]);
  expect(result.survivors).toEqual([]);
  expect(result.removed).toEqual([50_004]);
});

it("rechecks PID identity before SIGKILL", async () => {
  const { worktreePath, registry, signals, processes, waits, addProcess, setTerminateOnSignal } =
    makeFixture();
  addProcess(50_006);
  await registry.registerProcess({ worktreePath, pid: 50_006 });
  setTerminateOnSignal(false);
  waits.push(() => {
    const current = processes.get(50_006);
    if (current !== undefined) {
      processes.set(50_006, {
        ...current,
        identity: { ...current.identity, startTime: "reused-before-kill" },
      });
    }
  });

  const result = await registry.stop(worktreePath, { graceMs: 1, print: () => {} });

  expect(signals).toEqual([{ pid: 50_006, signal: "SIGTERM" }]);
  expect(result.survivors).toEqual([]);
  expect(result.removed).toEqual([50_006]);
});

it("skips SIGKILL if a process changes cwd after SIGTERM", async () => {
  const { worktreePath, registry, signals, waits, addProcess, processes, setTerminateOnSignal } =
    makeFixture();
  const outside = NodePath.join(NodePath.dirname(worktreePath), "another-worktree");
  NodeFS.mkdirSync(outside);
  addProcess(50_005);
  await registry.registerProcess({ worktreePath, pid: 50_005 });
  setTerminateOnSignal(false);
  waits.push(() => {
    const current = processes.get(50_005);
    if (current !== undefined) processes.set(50_005, { ...current, cwd: outside });
  });

  const result = await registry.stop(worktreePath, { graceMs: 1, print: () => {} });

  expect(signals).toEqual([{ pid: 50_005, signal: "SIGTERM" }]);
  expect(result.survivors).toEqual([
    expect.objectContaining({
      pid: 50_005,
      reason: "process cwd is outside its registered worktree",
    }),
  ]);
  expect(await registry.snapshot({ worktreePath })).toHaveLength(1);
});

it("filters a stop to one registered owner process", async () => {
  const { worktreePath, registry, signals, addProcess } = makeFixture();
  addProcess(50_009);
  addProcess(50_010);
  addProcess(51_001);
  addProcess(51_002);
  await registry.registerProcess({ worktreePath, pid: 50_009, ownerPid: 51_001 });
  await registry.registerProcess({ worktreePath, pid: 50_010, ownerPid: 51_002 });

  await registry.stop(worktreePath, { ownerPid: 51_001, graceMs: 0, print: () => {} });

  expect(signals).toEqual([{ pid: 50_009, signal: "SIGTERM" }]);
  expect(await registry.snapshot({ worktreePath })).toMatchObject([
    { pid: 50_010, ownerPid: 51_002 },
  ]);
});

it("reports a process registered while stop is in flight without signaling it", async () => {
  const { worktreePath, registry, signals, waits, addProcess } = makeFixture();
  addProcess(50_011);
  await registry.registerProcess({ worktreePath, pid: 50_011, sessionId: "session-late" });
  waits.push(async () => {
    addProcess(50_012);
    await registry.registerProcess({ worktreePath, pid: 50_012, sessionId: "session-late" });
  });

  const result = await registry.stop(worktreePath, {
    sessionId: "session-late",
    graceMs: 1,
    print: () => {},
  });

  expect(signals).toEqual([{ pid: 50_011, signal: "SIGTERM" }]);
  expect(result.survivors).toEqual([
    expect.objectContaining({ pid: 50_012, reason: "registered during stop" }),
  ]);
});
