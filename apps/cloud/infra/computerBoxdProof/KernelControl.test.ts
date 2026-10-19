import { describe, expect, it, vi } from "vite-plus/test";
import type { SeededChildProgramCatalogOptions } from "../childPrograms/runtime.ts";
import { asyncBinding } from "../../src/kernel/tests/kernelProgramAdmissionFixture.ts";
import { KernelOpenFlags } from "../../src/kernel/KernelFileSystem.ts";
import { createKernelProcessStreams } from "../../src/kernel/KernelProcessStreams.ts";
import { ChildWorkerCapacity } from "../../src/computer/ChildWorkerCapacity.ts";
import { EXPECTED_STDOUT, INITIAL_FILE, RESULT_FILE } from "./Command.ts";
import { sqliteFixture } from "./ProofSqliteFixture.ts";

const observed = vi.hoisted(() => ({
  contexts: [] as { admission: object | undefined; pid: number }[],
  capacity: undefined as ChildWorkerCapacity | undefined,
  execErrors: [] as string[],
}));

// These stand-ins exercise real kernel exec, descriptors and capacity without launching workerd.
vi.mock("../childPrograms/runtime.ts", () => ({
  createSeededChildProgramCatalog(options: SeededChildProgramCatalogOptions) {
    const lifetimes = new Set<Promise<unknown>>();
    const run: ChildWorkerCapacity["run"] = (signal, work) => {
      const lifetime = options.capacity.run(signal, work);
      lifetimes.add(lifetime);
      void lifetime.finally(() => lifetimes.delete(lifetime)).catch(() => undefined);
      return lifetime;
    };
    const root = asyncBinding("control-root", (context) =>
      run(context.signal, async () => {
        observed.contexts.push({ admission: context.admission, pid: context.identity.pid });
        try {
          return await context.exec({
            filesystem: context.filesystem,
            identity: context.identity,
            path: "/bin/control-child",
            args: ["control-child"],
            env: context.env,
            signal: context.signal,
          });
        } catch (error) {
          observed.execErrors.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      }),
    );
    const child = asyncBinding("control-child", (context) =>
      run(context.signal, async () => {
        observed.contexts.push({ admission: context.admission, pid: context.identity.pid });
        const streams = createKernelProcessStreams(context.filesystem, { signal: context.signal });
        const input: Uint8Array[] = [];
        for await (const chunk of streams.stdin) input.push(chunk);
        expect(new TextDecoder().decode(new Uint8Array(input.flatMap((chunk) => [...chunk])))).toBe(
          "input 雪\n",
        );
        const descriptor = context.filesystem.open(
          "/workspace/out.bin",
          KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
        );
        context.filesystem.write(descriptor, RESULT_FILE, null);
        context.filesystem.close(descriptor);
        const stdout = streams.stdout.getWriter();
        const stderr = streams.stderr.getWriter();
        await stdout.write(EXPECTED_STDOUT);
        await stderr.write(new Uint8Array([128, 0]));
        stdout.releaseLock();
        stderr.releaseLock();
        return { exitCode: 17, signal: 0, coreDumped: false };
      }),
    );
    const bindings = new Map([
      ["/bin/bash", root],
      ["/bin/control-child", child],
    ]);
    for (const binding of bindings.values()) {
      if (options.registry.register(binding.manifest).status !== "ok")
        throw new Error("Fixture program registration failed");
    }
    observed.capacity = options.capacity as ChildWorkerCapacity;
    return {
      bindings,
      drain: async () => {
        await Promise.all(lifetimes);
      },
    };
  },
}));

import { proofKernel } from "./Kernel.ts";

describe("proof local control before nested machine binding", () => {
  it("runs a real kernel replacement with bytes and capacity settled without admission grants", async () => {
    observed.contexts.length = 0;
    observed.execErrors.length = 0;
    const reserves = vi.spyOn(ChildWorkerCapacity.prototype, "tryReserve");
    const sql = sqliteFixture();
    const code = { mainModule: "test-only", modules: {} };
    const kernel = proofKernel(sql.storage, {} as WorkerLoader, {
      sourceCommit: "0".repeat(40),
      runner: { bytes: new Uint8Array(), sha256: "test-only" },
      programs: { bash: code, busyboxCat: code, ripgrep: code },
      executables: [],
    });
    try {
      const failure = await kernel.localControl(new AbortController().signal).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(observed.execErrors).toEqual([]);
      expect(failure).toBeUndefined();
      expect(observed.contexts).toHaveLength(2);
      expect(observed.contexts.every((context) => context.admission === undefined)).toBe(true);
      expect(observed.contexts[0]?.pid).toBe(observed.contexts[1]?.pid);
      expect(reserves).not.toHaveBeenCalled();
      expect(observed.capacity?.active).toBe(0);
      expect(kernel.host.processes.size).toBe(0);
      const descriptor = kernel.filesystem.open("/workspace/out.bin", KernelOpenFlags.O_RDONLY);
      const bytes = new Uint8Array(INITIAL_FILE.length);
      expect(kernel.filesystem.read(descriptor, bytes, 0n)).toBe(INITIAL_FILE.length);
      expect(bytes).toEqual(INITIAL_FILE);
      kernel.filesystem.close(descriptor);
    } finally {
      await kernel.close();
      sql.close();
      reserves.mockRestore();
    }
  });
});
