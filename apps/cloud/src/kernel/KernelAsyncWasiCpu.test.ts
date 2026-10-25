import { describe, expect, it } from "@effect/vitest";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  callKernel,
  type KernelHandle,
  type RegisteredProgram,
} from "./KernelAbi.ts";
import { KernelCpuAccounting } from "./KernelCpuAccounting.ts";
import type { KernelCpuProcessExecution } from "./KernelCpuExecution.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelProgramHost } from "./KernelProgramHost.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";

function isWasmFunction(value: unknown): value is (...args: (number | bigint)[]) => unknown {
  return typeof value === "function";
}

function makeClock() {
  let now = 0n;
  return {
    read: () => now,
    advance: (amount: bigint) => {
      now += amount;
    },
  };
}

function manifest(name: string): RegisteredProgram {
  return {
    name,
    version: "1",
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.wait"],
    entrypoint: name,
  };
}

function spawn(host: KernelProgramHost, filesystem: KernelFileSystem): KernelHandle<"process"> {
  const program = host.resolve("/bin/reactor");
  if (program.status !== "ok") throw new Error("Program resolution failed");
  const prepared = host.prepare({ filesystem });
  const child = callKernel(host.backend(prepared), "process.spawn", {
    program: program.value,
    args: [],
    env: {},
  });
  if (child.status !== "ok") throw new Error("Program spawn failed");
  return child.value;
}

describe("async program WASI CPU entry", () => {
  it("keeps reactor reentry and close guarded before the deferred export starts", async () => {
    const filesystem = new KernelFileSystem({ mounts: [] });
    const wakes = new KernelWakeRegistry();
    const runtime = createKernelAsyncWasi({ filesystem, wakes });
    const instance = new WebAssembly.Instance(wasmImportReactor("fixture", "work", []), {
      ...runtime.wasi.getImportObject(),
      fixture: { work: () => undefined },
    });
    const run = instance.exports.run;
    if (!isWasmFunction(run)) throw new Error("Reactor export is missing");
    await runtime.wasi.initialize(instance);
    try {
      const first = runtime.wasi.run(run);
      const reentry = runtime.wasi.run(run);
      const close = runtime.wasi.close();
      await Promise.all([
        expect(reentry).rejects.toThrow("unavailable or already executing"),
        expect(close).rejects.toThrow("still executing"),
        first,
      ]);
    } finally {
      await runtime.wasi.close();
      wakes.dispose();
      filesystem.dispose();
    }
  });

  it("finishes an immediately entered reactor without overlapping the initial async user scope", async () => {
    const clock = makeClock();
    const filesystem = new KernelFileSystem({ mounts: [] });
    const wakes = new KernelWakeRegistry();
    const runtime = createKernelAsyncWasi({ filesystem, wakes });
    const module = wasmImportReactor("fixture", "user_work", []);
    const instance = new WebAssembly.Instance(module, {
      ...runtime.wasi.getImportObject(),
      fixture: { user_work: () => clock.advance(3n) },
    });
    const run = instance.exports.run;
    if (!isWasmFunction(run)) throw new Error("Reactor export is missing");
    await runtime.wasi.initialize(instance);
    const registry = new KernelProgramRegistry();
    const program = manifest("immediate-reactor");
    if (registry.register(program).status !== "ok") throw new Error("Registration failed");
    let guestCompletion: Promise<unknown> | undefined;
    let cpu: KernelCpuProcessExecution | undefined;
    const host = new KernelProgramHost({
      registry,
      wakes,
      cpuAccounting: new KernelCpuAccounting(clock.read),
      programs: new Map([
        [
          "/bin/reactor",
          {
            manifest: program,
            implementation: {
              kind: "async",
              run: async (context) => {
                cpu = host.cpuExecution?.forProcess(context.identity.pid);
                clock.advance(2n);
                guestCompletion = runtime.wasi.run(run);
                await guestCompletion;
                if (!context.cpu) throw new Error("CPU helper is missing");
                context.cpu.runUser(() => clock.advance(5n));
                return { exitCode: 0, signal: 0, coreDumped: false };
              },
            },
          },
        ],
      ]),
    });
    try {
      const child = spawn(host, filesystem);
      expect(await host.exitStatus(child)).toEqual({
        status: "ok",
        value: { exitCode: 0, signal: 0, coreDumped: false },
      });
      expect(cpu?.snapshot()).toEqual({ userNs: 10n, systemNs: 0n });
      expect(host.reap(child).status).toBe("ok");
      expect(host.processes.size).toBe(0);
      expect(wakes.size).toBe(0);
    } finally {
      await guestCompletion?.catch(() => undefined);
      await runtime.wasi.close();
      await host.processes.dispose();
      wakes.dispose();
      filesystem.dispose();
    }
  });

  it("keeps a forked child's PID and CPU ownership through exec while excluding its wait", async () => {
    const clock = makeClock();
    const filesystem = new KernelFileSystem({ mounts: [] });
    const wakes = new KernelWakeRegistry();
    const registry = new KernelProgramRegistry();
    const parentManifest = manifest("forking-reactor");
    const replacementManifest = manifest("fork-replacement");
    for (const program of [parentManifest, replacementManifest]) {
      if (registry.register(program).status !== "ok") throw new Error("Registration failed");
    }
    const childStarted = Promise.withResolvers<void>();
    const finishIo = Promise.withResolvers<void>();
    let parentCpu: KernelCpuProcessExecution | undefined;
    let childCpu: KernelCpuProcessExecution | undefined;
    let forkPid = 0;
    let execPid = 0;
    const host = new KernelProgramHost({
      registry,
      wakes,
      cpuAccounting: new KernelCpuAccounting(clock.read),
      programs: new Map([
        [
          "/bin/reactor",
          {
            manifest: parentManifest,
            implementation: {
              kind: "async",
              run: async (context) => {
                const cpu = context.cpu;
                if (!cpu) throw new Error("CPU helper is missing");
                parentCpu = host.cpuExecution?.forProcess(context.identity.pid);
                clock.advance(2n);
                let forkCpu: typeof cpu | undefined;
                const child = context.processes.spawn(
                  context.identity.handle,
                  (identity) => {
                    forkPid = identity.pid;
                    forkCpu = cpu.forProcess(identity.pid);
                    childCpu = host.cpuExecution?.forProcess(identity.pid);
                    const completion = forkCpu.run(async () => {
                      forkCpu?.runUser(() => clock.advance(3n));
                      childStarted.resolve();
                      await finishIo.promise;
                      return context.exec({
                        filesystem: context.filesystem,
                        identity,
                        args: [],
                        env: {},
                        signal: context.signal,
                        path: "/bin/replacement",
                      });
                    });
                    return { completion, signal: () => ({ status: "ok", value: undefined }) };
                  },
                  () => {
                    forkCpu?.stop();
                  },
                );
                if (child.status !== "ok") throw new Error("Fork admission failed");
                clock.advance(4n);
                const result = await host.exitStatus(child.value.handle);
                if (result.status !== "ok") throw new Error("Fork failed to finish");
                cpu.runUser(() => clock.advance(7n));
                expect(context.processes.reap(child.value.handle).status).toBe("ok");
                return result.value;
              },
            },
          },
        ],
        [
          "/bin/replacement",
          {
            manifest: replacementManifest,
            implementation: {
              kind: "async",
              run: async (context) => {
                execPid = host.cpuExecution?.current()?.pid ?? 0;
                if (!context.cpu) throw new Error("Replacement CPU helper is missing");
                context.cpu.runUser(() => clock.advance(5n));
                return { exitCode: 0, signal: 0, coreDumped: false };
              },
            },
          },
        ],
      ]),
    });
    try {
      const child = spawn(host, filesystem);
      await childStarted.promise;
      clock.advance(100_000n);
      finishIo.resolve();
      expect(await host.exitStatus(child)).toMatchObject({ status: "ok", value: { exitCode: 0 } });
      expect(forkPid).toBeGreaterThan(2);
      expect(execPid).toBe(forkPid);
      expect(parentCpu?.snapshot()).toEqual({ userNs: 13n, systemNs: 0n });
      expect(childCpu?.snapshot()).toEqual({ userNs: 8n, systemNs: 0n });
      expect(host.reap(child).status).toBe("ok");
      expect(host.processes.size).toBe(0);
      expect(wakes.size).toBe(0);
    } finally {
      finishIo.resolve();
      await host.processes.dispose();
      wakes.dispose();
      filesystem.dispose();
    }
  });
});
