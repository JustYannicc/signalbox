// @effect-diagnostics globalTimers:off - these tests exercise native event-loop task delivery without Effect.
import { describe, expect, it } from "vite-plus/test";

import { AgentOsProcessHost } from "./AgentOsProcessHost.ts";
import { kernelError, kernelOk } from "./KernelAbi.ts";
import { KernelCpuAccounting } from "./KernelCpuAccounting.ts";
import {
  KernelCpuExecution,
  runCurrentKernelCpuAwaitableSystemImport,
} from "./KernelCpuExecution.ts";
import { KERNEL_WNOHANG, KernelProcessTable, type KernelExitStatus } from "./KernelProcessTable.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";

function fixture() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const wakes = new KernelWakeRegistry();
  const processes = new KernelProcessTable({ wakes });
  const controller = new AbortController();
  const completion = Promise.withResolvers<KernelExitStatus>();
  const spawned = processes.spawn(
    undefined,
    () => ({ completion: completion.promise, signal: () => kernelOk(undefined) }),
    () => {},
  );
  if (spawned.status !== "ok") throw new Error("Could not start test child");
  const host = new AgentOsProcessHost({
    memory: () => memory,
    processes,
    wakes,
    signal: controller.signal,
    spawn: async () => kernelError("UNSUPPORTED", "Unused test spawn"),
  });
  return {
    memory,
    wakes,
    processes,
    controller,
    completion,
    child: spawned.value,
    host,
    poll: () => host.imports.proc_waitpid_v2(spawned.value.pid, KERNEL_WNOHANG, 0, 4, 8, 12),
    output: () => Array.from(new Uint32Array(memory.buffer, 0, 4)),
    async dispose() {
      completion.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      await processes.dispose();
      wakes.dispose();
    },
  };
}

describe("AgentOS WNOHANG scheduling", () => {
  it("lets a queued child task complete during bounded guest polls", async () => {
    const test = fixture();
    // This task is the child's completion event, not a delay before an assertion.
    const task = setTimeout(() => {
      test.completion.resolve({ exitCode: 23, signal: 0, coreDumped: false });
    }, 0);
    try {
      for (let poll = 0; poll < 32; poll++) {
        expect(await test.poll()).toBe(0);
        if (test.output()[2] !== 0) break;
      }
      expect(test.output()).toEqual([23, 0, test.child.pid, 0]);
      expect(test.processes.size).toBe(0);
      expect(test.wakes.size).toBe(0);
      expect(await test.poll()).toBe(12);
    } finally {
      clearTimeout(task);
      await test.dispose();
    }
  });

  it("returns zero without waiting for a live child to terminate", async () => {
    const test = fixture();
    try {
      new Uint32Array(test.memory.buffer, 0, 4).fill(0xfeed_beef);
      expect(await test.poll()).toBe(0);
      expect(test.output()).toEqual([0, 0, 0, 0]);
      expect(test.processes.size).toBe(1);
      expect(test.wakes.size).toBe(0);
    } finally {
      await test.dispose();
    }
  });

  it("observes cancellation delivered by a queued task without writing outputs", async () => {
    const test = fixture();
    const task = setTimeout(() => test.controller.abort(), 0);
    try {
      new Uint32Array(test.memory.buffer, 0, 4).fill(0xfeed_beef);
      expect(await test.poll()).toBe(11);
      expect(test.output()).toEqual(Array(4).fill(0xfeed_beef));
      expect(test.processes.size).toBe(1);
      expect(test.wakes.size).toBe(0);
    } finally {
      clearTimeout(task);
      await test.dispose();
    }
  });

  it("keeps invalid calls atomic and blocking waits tied to child completion", async () => {
    const test = fixture();
    try {
      new Uint32Array(test.memory.buffer, 0, 4).fill(0xfeed_beef);
      expect(await test.host.imports.proc_waitpid_v2(test.child.pid, 1, 0, 4, 8, 65_534)).toBe(21);
      expect(await test.host.imports.proc_waitpid_v2(test.child.pid, 3, 0, 4, 8, 12)).toBe(28);
      expect(test.output()).toEqual(Array(4).fill(0xfeed_beef));
      const waiting = test.host.imports.proc_waitpid_v2(test.child.pid, 0, 0, 4, 8, 12);
      expect(test.wakes.size).toBe(1);
      test.completion.resolve({ exitCode: 7, signal: 15, coreDumped: true });
      expect(await waiting).toBe(0);
      expect(test.output()).toEqual([7, 15, test.child.pid, 1]);
      expect(test.processes.size).toBe(0);
      expect(test.wakes.size).toBe(0);
    } finally {
      await test.dispose();
    }
  });

  it("does not charge time spent yielding as process CPU", async () => {
    const test = fixture();
    let now = 0n;
    const execution = new KernelCpuExecution(new KernelCpuAccounting(() => now));
    const task = setTimeout(() => {
      now += 100_000n;
    }, 0);
    try {
      const errno = await execution.root.run(async () => {
        const leave = execution.root.enterUser();
        now += 2n;
        const result = await runCurrentKernelCpuAwaitableSystemImport(test.poll);
        now += 3n;
        leave();
        return result;
      });
      expect(errno).toBe(0);
      expect(now).toBe(100_005n);
      expect(execution.root.stop()).toEqual({ userNs: 5n, systemNs: 0n });
      expect(test.output()).toEqual([0, 0, 0, 0]);
    } finally {
      clearTimeout(task);
      await test.dispose();
    }
  });
});
