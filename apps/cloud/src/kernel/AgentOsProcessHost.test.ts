import { describe, expect, it } from "vite-plus/test";

import { kernelError, kernelOk } from "./KernelAbi.ts";
import { AgentOsProcessHost } from "./AgentOsProcessHost.ts";
import { KernelProcessTable, type KernelExitStatus } from "./KernelProcessTable.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fixture() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const wakes = new KernelWakeRegistry();
  const processes = new KernelProcessTable({ wakes });
  const completion = deferred<KernelExitStatus>();
  const deliveredSignals: number[] = [];
  const spawned = processes.spawn(
    undefined,
    () => ({
      completion: completion.promise,
      signal: (signal) => {
        deliveredSignals.push(signal);
        return kernelOk(undefined);
      },
    }),
    () => {},
  );
  if (spawned.status !== "ok") throw new Error("Could not start test child");

  const host = new AgentOsProcessHost({
    memory: () => memory,
    processes,
    wakes,
    spawn: async () => kernelError("UNSUPPORTED", "Unused test spawn"),
  });
  return {
    memory,
    wakes,
    processes,
    completion,
    child: spawned.value,
    deliveredSignals,
    host,
    async dispose() {
      completion.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      await processes.dispose();
      wakes.dispose();
    },
  };
}

describe("AgentOS host_process process imports", () => {
  it("returns ENOTSUP for valid signal-mask operations without changing output memory", async () => {
    const test = fixture();
    try {
      const view = new DataView(test.memory.buffer);
      view.setUint32(4, 0xfeed_beef, true);
      view.setUint32(8, 0xcafe_babe, true);

      for (const how of [0, 1, 2, 3]) {
        expect(test.host.imports.proc_signal_mask_v2(how, 1, 2, 4, 8)).toBe(58);
      }
      expect(test.host.imports.proc_signal_mask_v2(4, 0, 0, 4, 8)).toBe(28);
      expect(test.host.imports.proc_signal_mask_v2(3, 0, 0, 65_534, 8)).toBe(21);
      expect(view.getUint32(4, true)).toBe(0xfeed_beef);
      expect(view.getUint32(8, true)).toBe(0xcafe_babe);
    } finally {
      await test.dispose();
    }
  });

  it("reports identity and signals only a live child, with zero checking but not delivering", async () => {
    const test = fixture();
    try {
      expect(test.host.imports.proc_getpid(16)).toBe(0);
      expect(test.host.imports.proc_getppid(20)).toBe(0);
      expect(new DataView(test.memory.buffer).getUint32(16, true)).toBe(1);
      expect(new DataView(test.memory.buffer).getUint32(20, true)).toBe(0);

      expect(test.host.imports.proc_kill(0, 15)).toBe(71);
      expect(test.host.imports.proc_kill(-test.child.pid, 15)).toBe(28);
      expect(test.host.imports.proc_kill(test.child.pid, 0)).toBe(0);
      expect(test.deliveredSignals).toEqual([]);
      expect(test.host.imports.proc_kill(test.child.pid, 15)).toBe(0);
      expect(test.deliveredSignals).toEqual([15]);

      const waiting = test.processes.exitStatus(test.child.handle);
      expect(waiting.status).toBe("would_block");
      if (waiting.status !== "would_block") return;
      const wake = test.wakes.wait(waiting.wakeToken);
      test.completion.resolve({ exitCode: 143, signal: 15, coreDumped: false });
      expect(await wake).toEqual({ status: "ok", value: undefined });
      expect(test.processes.exitStatus(test.child.handle)).toEqual({
        status: "ok",
        value: { exitCode: 143, signal: 15, coreDumped: false },
      });

      expect(test.host.imports.proc_kill(test.child.pid, 15)).toBe(71);
      expect(test.host.imports.proc_kill(99, 0)).toBe(71);
    } finally {
      await test.dispose();
    }
  });
});
