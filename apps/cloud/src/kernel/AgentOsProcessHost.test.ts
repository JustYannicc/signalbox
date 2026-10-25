import { describe, expect, it } from "vite-plus/test";

import { kernelError, kernelOk } from "./KernelAbi.ts";
import { AgentOsProcessHost } from "./AgentOsProcessHost.ts";
import { KernelProcessTable, type KernelExitStatus } from "./KernelProcessTable.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { KernelCpuAccounting } from "./KernelCpuAccounting.ts";
import {
  KernelCpuExecution,
  runCurrentKernelCpuAwaitableSystemImport,
} from "./KernelCpuExecution.ts";

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
  it("lets a guest query its signal mask before spawning a command", async () => {
    const test = fixture();
    let spawnCalls = 0;
    const host = new AgentOsProcessHost({
      memory: () => test.memory,
      processes: test.processes,
      wakes: test.wakes,
      spawn: async () => {
        spawnCalls++;
        return kernelOk(test.child.handle);
      },
    });
    new Uint8Array(test.memory.buffer, 32, 9).set(new TextEncoder().encode("/bin/tool"));
    try {
      const errno = host.imports.proc_signal_mask_v2(3, 0, 0, 4, 8);
      expect(errno).toBe(0);
      const view = new DataView(test.memory.buffer);
      expect(view.getUint32(4, true)).toBe(0);
      expect(view.getUint32(8, true)).toBe(0);
      expect(
        await host.imports.proc_spawn_v3(32, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 512),
      ).toBe(0);
      expect(spawnCalls).toBe(1);
      expect(view.getUint32(512, true)).toBe(test.child.pid);
    } finally {
      await test.dispose();
    }
  });

  it("charges spawn decode and output but excludes non-wake admission waits", async () => {
    const test = fixture();
    let now = 0n;
    let reads = 0;
    const execution = new KernelCpuExecution(new KernelCpuAccounting(() => now));
    const admission = deferred<void>();
    new Uint8Array(test.memory.buffer, 32, 9).set(new TextEncoder().encode("/bin/tool"));
    const host = new AgentOsProcessHost({
      memory: () => {
        now += reads++ === 0 ? 2n : 3n;
        return test.memory;
      },
      processes: test.processes,
      wakes: test.wakes,
      spawn: (request) => {
        expect(request.execPath).toBe("/bin/tool");
        now += 5n;
        return admission.promise.then(() => kernelOk(test.child.handle));
      },
    });
    try {
      const spawning = execution.root.run(() => {
        const leave = execution.root.enterUser();
        now += 1n;
        return runCurrentKernelCpuAwaitableSystemImport(() =>
          host.imports.proc_spawn_v3(32, 9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 512),
        ).then((errno) => {
          now += 7n;
          leave();
          return errno;
        });
      });
      now += 100_000n;
      admission.resolve();
      expect(await spawning).toBe(0);
      expect(new DataView(test.memory.buffer).getUint32(512, true)).toBe(test.child.pid);
      expect(test.wakes.size).toBe(0);
      expect(execution.root.stop()).toEqual({ userNs: 8n, systemNs: 10n });
    } finally {
      await test.dispose();
    }
  });
  it("shares the authoritative root mask and validates all outputs before mutation", async () => {
    const test = fixture();
    const anotherHost = new AgentOsProcessHost({
      memory: () => test.memory,
      processes: test.processes,
      wakes: test.wakes,
      spawn: async () => kernelError("UNSUPPORTED", "Unused test spawn"),
    });
    try {
      const view = new DataView(test.memory.buffer);
      expect(test.host.imports.proc_signal_mask_v2(0, 0x8000_4000, 0x8000_0001, 4, 8)).toBe(0);
      expect(view.getUint32(4, true)).toBe(0);
      expect(view.getUint32(8, true)).toBe(0);
      expect(anotherHost.imports.proc_signal_mask_v2(3, -1, -1, 4, 8)).toBe(0);
      expect(view.getUint32(4, true)).toBe(0x8000_4000);
      expect(view.getUint32(8, true)).toBe(0x8000_0001);

      view.setUint32(4, 0xfeed_beef, true);
      view.setUint32(8, 0xcafe_babe, true);
      expect(test.host.imports.proc_signal_mask_v2(4, 0, 0, 4, 8)).toBe(28);
      expect(test.host.imports.proc_signal_mask_v2(2, 0, 0, 4, 65_534)).toBe(21);
      expect(test.host.imports.proc_signal_mask_v2(2, 0, 0, 65_534, 8)).toBe(21);
      expect(view.getUint32(4, true)).toBe(0xfeed_beef);
      expect(view.getUint32(8, true)).toBe(0xcafe_babe);
      expect(anotherHost.imports.proc_signal_mask_v2(3, 0, 0, 4, 8)).toBe(0);
      expect(view.getUint32(4, true)).toBe(0x8000_4000);
      expect(view.getUint32(8, true)).toBe(0x8000_0001);

      expect(test.host.imports.proc_signal_mask_v2(1, 0x4000, 1, 4, 8)).toBe(0);
      expect(view.getUint32(4, true)).toBe(0x8000_4000);
      expect(view.getUint32(8, true)).toBe(0x8000_0001);
      expect(anotherHost.imports.proc_signal_mask_v2(3, 0, 0, 4, 8)).toBe(0);
      expect(view.getUint32(4, true)).toBe(0x8000_0000);
      expect(view.getUint32(8, true)).toBe(0x8000_0000);
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
