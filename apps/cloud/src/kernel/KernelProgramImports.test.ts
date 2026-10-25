import { describe, expect, it, vi } from "vite-plus/test";
import { ABI_VERSION, callKernel, KernelProgramRegistry, KernelWakeRegistry } from "./KernelAbi.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { KernelProgramHost, type KernelProgramBinding } from "./KernelProgramHost.ts";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { wasmImportReactor, wasmSignalMaskCommand, wasmSpawnCommand } from "./tests/wasmGuest.ts";

function setup(parentModule: WebAssembly.Module) {
  const fixture = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [{ path: "/", storage: createFacetSqliteStorage(fixture.storage, () => 1n) }],
  });
  const registry = new KernelProgramRegistry();
  const wakes = new KernelWakeRegistry();
  const childMasks: Array<{ low: number; high: number }> = [];
  const child = vi.fn(async (context: KernelAsyncProgramContext) => {
    const mask = context.processes.signalMask(context.identity.handle, 3);
    if (mask.status !== "ok") throw new Error("Child mask was unavailable");
    childMasks.push(mask.value);
    return { exitCode: 0, signal: 0, coreDumped: false };
  });
  const programs = new Map<string, KernelProgramBinding>();
  for (const [name, implementation] of [
    ["parent", { kind: "wasm", module: parentModule }],
    ["child", { kind: "async", run: child }],
  ] as const) {
    const manifest = {
      name,
      version: "1",
      abiVersion: ABI_VERSION,
      requiredCapabilities: [],
      entrypoint: name,
    };
    expect(registry.register(manifest).status).toBe("ok");
    programs.set(`/bin/${name}`, { manifest, implementation });
  }
  const host = new KernelProgramHost({ registry, wakes, programs });
  return {
    host,
    filesystem,
    wakes,
    child,
    childMasks,
    async close() {
      await host.processes.dispose();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    },
  };
}

describe("program guest imports", () => {
  it("keeps unadmitted inline guests from accessing the root process mask", async () => {
    const context = setup(wasmSignalMaskCommand(2, 0, 0));
    const mask = { low: 0x4000, high: 1 };
    expect(context.host.processes.signalMask(undefined, 2, mask).status).toBe("ok");
    const prepared = context.host.prepare({ filesystem: context.filesystem });
    try {
      const resolved = context.host.resolve("/bin/parent");
      if (resolved.status !== "ok") throw new Error("Parent resolution failed");
      expect(context.host.runInline(prepared, resolved.value, [], {})).toBe(58);
      expect(context.child).not.toHaveBeenCalled();
      expect(context.host.processes.signalMask(undefined, 3)).toEqual({
        status: "ok",
        value: mask,
      });
    } finally {
      await prepared.release();
      await context.close();
    }
  });

  it("queries and passes the inherited mask through the real WASM spawn boundary", async () => {
    const context = setup(wasmSpawnCommand(0, 0, 0, true));
    const mask = { low: 0x8000_4000, high: 0x8000_0001 };
    expect(context.host.processes.signalMask(undefined, 2, mask).status).toBe("ok");
    const prepared = context.host.prepare({ filesystem: context.filesystem });
    try {
      const resolved = context.host.resolve("/bin/parent");
      if (resolved.status !== "ok") throw new Error("Parent resolution failed");
      const spawned = callKernel(context.host.backend(prepared), "process.spawn", {
        program: resolved.value,
        args: [],
        env: {},
      });
      if (spawned.status !== "ok") throw new Error("Parent admission failed");
      expect(await context.host.exitStatus(spawned.value)).toMatchObject({
        status: "ok",
        value: { exitCode: 0, signal: 0 },
      });
      expect(context.child).toHaveBeenCalledOnce();
      expect(context.childMasks).toEqual([mask]);
      expect(context.host.processes.signalMask(undefined, 3)).toEqual({
        status: "ok",
        value: mask,
      });
    } finally {
      await prepared.release();
      await context.close();
    }
  });

  it.each([
    [0, 1, 0],
    [2, 1, 0],
    [0, 0, 1],
    [8, 0x8000_4000, 0x8000_0001],
  ])(
    "applies supplied masks before child admission (flags=%i, low=%i, high=%i)",
    async (flags, low, high) => {
      const context = setup(wasmSpawnCommand(flags, low, high));
      const { host, filesystem, child } = context;
      const prepared = host.prepare({ filesystem });
      try {
        const resolved = host.resolve("/bin/parent");
        if (resolved.status !== "ok") throw new Error("Parent resolution failed");
        const spawned = callKernel(host.backend(prepared), "process.spawn", {
          program: resolved.value,
          args: [],
          env: {},
        });
        if (spawned.status !== "ok") throw new Error("Parent admission failed");
        expect(await host.exitStatus(spawned.value)).toMatchObject({
          status: "ok",
          value: { exitCode: 0, signal: 0 },
        });
        expect(child).toHaveBeenCalledOnce();
        expect(context.childMasks).toEqual([{ low, high }]);
        expect(host.processes.size).toBe(2);
      } finally {
        await prepared.release();
        await context.close();
      }
    },
  );

  it("ignores only the unblockable SIGKILL and SIGSTOP bits", async () => {
    const context = setup(wasmSpawnCommand(0, (1 << 8) | (1 << 18), 0));
    const { host, filesystem, child } = context;
    const prepared = host.prepare({ filesystem });
    try {
      const resolved = host.resolve("/bin/parent");
      if (resolved.status !== "ok") throw new Error("Parent resolution failed");
      const spawned = callKernel(host.backend(prepared), "process.spawn", {
        program: resolved.value,
        args: [],
        env: {},
      });
      if (spawned.status !== "ok") throw new Error("Parent admission failed");
      expect(await host.exitStatus(spawned.value)).toMatchObject({
        status: "ok",
        value: { exitCode: 0, signal: 0 },
      });
      expect(child).toHaveBeenCalledOnce();
      expect(context.childMasks).toEqual([{ low: 0, high: 0 }]);
    } finally {
      await prepared.release();
      await context.close();
    }
  });

  it.each([1, 4, 16, 32, 64, 128])("rejects unsupported spawn attributes %i", async (flags) => {
    const context = setup(wasmSpawnCommand(flags, 0, 0));
    const prepared = context.host.prepare({ filesystem: context.filesystem });
    try {
      const resolved = context.host.resolve("/bin/parent");
      if (resolved.status !== "ok") throw new Error("Parent resolution failed");
      const spawned = callKernel(context.host.backend(prepared), "process.spawn", {
        program: resolved.value,
        args: [],
        env: {},
      });
      if (spawned.status !== "ok") throw new Error("Parent admission failed");
      expect(await context.host.exitStatus(spawned.value)).toMatchObject({
        status: "ok",
        value: { exitCode: 58 },
      });
      expect(context.child).not.toHaveBeenCalled();
      expect(context.host.processes.size).toBe(1);
    } finally {
      await prepared.release();
      await context.close();
    }
  });

  it("polls supplied stdio through the prepared child's shared WASI table", async () => {
    const module = wasmImportReactor(
      "wasi_snapshot_preview1",
      "poll_oneoff",
      ["i32", "i32", "i32", "i32"],
      ["i32"],
    );
    const context = setup(module);
    const { host, filesystem, wakes } = context;
    const poll = vi.fn(() => ({ bytes: 17n }));
    const prepared = host.prepare({ filesystem }, { stdio: [{ readInto: () => 0, poll }, {}, {}] });
    const { wasi } = createKernelAsyncWasi({ filesystem: prepared.filesystem, wakes });
    try {
      const instance = new WebAssembly.Instance(module, wasi.getImportObject());
      const memory = instance.exports.memory;
      const run = instance.exports.run;
      if (!(memory instanceof WebAssembly.Memory) || typeof run !== "function")
        throw new Error("Invalid reactor");
      await wasi.initialize(instance);
      const view = new DataView(memory.buffer);
      view.setUint8(8, 1);
      view.setUint32(16, 0, true);
      expect(
        await wasi.run(run as (...args: Array<number | bigint>) => unknown, 0, 64, 1, 96),
      ).toBe(0);
      expect(view.getUint32(96, true)).toBe(1);
      expect(view.getUint16(72, true)).toBe(0);
      expect(view.getBigUint64(80, true)).toBe(17n);
      expect(poll).toHaveBeenCalledOnce();
    } finally {
      await wasi.close();
      await prepared.release();
      await context.close();
    }
  });
});
