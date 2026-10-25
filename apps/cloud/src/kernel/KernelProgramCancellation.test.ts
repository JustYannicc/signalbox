import { describe, expect, it, vi } from "vite-plus/test";
import {
  ABI_VERSION,
  KernelProgramRegistry,
  KernelWakeRegistry,
  callKernel,
  type RegisteredProgram,
} from "./KernelAbi.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import {
  KernelProgramHost,
  type KernelProgramBinding,
  type KernelInlineProgram,
  type KernelProgramPrepareOptions,
} from "./KernelProgramHost.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";

const manifest: RegisteredProgram = {
  name: "cancelled-tool",
  version: "1.0.0",
  abiVersion: ABI_VERSION,
  requiredCapabilities: ["process.wait"],
  entrypoint: "cancelled-tool-sync-v1",
};

function createHarness() {
  const wakes = new KernelWakeRegistry();
  const registry = new KernelProgramRegistry();
  const runner = vi.fn<KernelInlineProgram>(() => 0);
  const binding = {
    manifest,
    implementation: { kind: "javascript", runInline: runner },
  } satisfies KernelProgramBinding;
  const registration = registry.register(manifest);
  if (registration.status !== "ok") throw new Error("Test program registration failed");
  const host = new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([["/bin/cancelled-tool", binding]]),
  });
  const fixture = sqliteFixture();
  const filesystem = new KernelFileSystem({
    mounts: [
      {
        path: "/",
        storage: createFacetSqliteStorage(fixture.storage, () => 1_800_000_000_000_000_001n),
      },
    ],
  });
  const resolved = host.resolve("/bin/cancelled-tool");
  if (resolved.status !== "ok") throw new Error("Program resolution failed");

  return {
    filesystem,
    fixture,
    host,
    resolved: resolved.value,
    runner,
    wakes,
    spawn(signal?: AbortSignal, options?: KernelProgramPrepareOptions) {
      const prepared = host.prepare(
        { filesystem, ...(signal === undefined ? {} : { signal }) },
        options,
      );
      const childFilesystem = prepared.filesystem;
      const result = callKernel(host.backend(prepared), "process.spawn", {
        program: resolved.value,
        args: [],
        env: {},
      });
      if (result.status !== "ok") throw new Error("Expected synchronous process admission");
      const info = host.processes.info(result.value);
      if (info.status !== "ok") throw new Error("Admitted process lost its identity");
      return {
        handle: result.value,
        pid: info.value.pid,
        childFilesystem,
        prepared,
      };
    },
    async dispose() {
      await host.processes.dispose();
      filesystem.dispose();
      fixture.close();
      wakes.dispose();
    },
  };
}

describe("KernelProgramHost cancellation", () => {
  it.each(["cancel", 9, 15, "none"] as const)(
    "preserves %s when a running JS callback throws",
    async (termination) => {
      const test = createHarness();
      const controller = new AbortController();
      test.runner.mockImplementation(({ filesystem }) => {
        filesystem.write(1, new Uint8Array([1]), null);
        return 0;
      });
      const child = test.spawn(controller.signal, {
        stdio: [
          {},
          {
            write() {
              if (termination === "cancel") controller.abort();
              else if (typeof termination === "number")
                test.host.processes.signal(child.handle, termination);
              throw Object.assign(new Error("Output stopped"), { code: "ECANCELED" });
            },
          },
          {},
        ],
      });
      const cleanup = vi.spyOn(child.childFilesystem, "dispose");
      const expected =
        typeof termination === "number"
          ? { status: "ok", value: { exitCode: 0, signal: termination, coreDumped: false } }
          : {
              status: "error",
              error: { code: termination === "cancel" ? "CANCELLED" : "IO_ERROR" },
            };
      try {
        expect(await test.host.exitStatus(child.handle)).toMatchObject(expected);
        expect(test.host.processes.wait(child.handle)).toMatchObject(
          typeof termination === "number" ? { status: "ok", value: { exitCode: 0 } } : expected,
        );
        expect(test.host.processes.waitpid(undefined, child.pid)).toMatchObject(
          typeof termination === "number"
            ? { status: "ok", value: { pid: child.pid, status: expected.value } }
            : expected,
        );
        await child.prepared.release();
        expect(test.runner).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
        expect(test.host.processes.size).toBe(0);
        expect(test.wakes.size).toBe(0);
      } finally {
        await test.dispose();
      }
    },
  );

  it("keeps inherited cancellation distinct through every handle-based wait surface", async () => {
    const test = createHarness();
    const controller = new AbortController();
    const child = test.spawn(controller.signal);
    controller.abort();

    try {
      await expect(test.host.exitStatus(child.handle)).resolves.toMatchObject({
        status: "error",
        error: { code: "CANCELLED" },
      });
      expect(test.host.processes.exitStatus(child.handle)).toMatchObject({
        status: "error",
        error: { code: "CANCELLED" },
      });
      expect(test.host.processes.wait(child.handle)).toMatchObject({
        status: "error",
        error: { code: "CANCELLED" },
      });
      expect(test.host.processes.lookupPid(child.pid)).toMatchObject({
        status: "ok",
        value: { status: "cancelled" },
      });
      expect(test.host.processes.reap(child.handle)).toMatchObject({
        status: "error",
        error: { code: "CANCELLED" },
      });
      expect(test.host.processes.exitStatus(child.handle)).toMatchObject({
        status: "error",
        error: { code: "INVALID_HANDLE" },
      });
      expect(test.runner).not.toHaveBeenCalled();
      expect(() => child.childFilesystem.cwd).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(() => test.filesystem.cwd).not.toThrow();
      await child.prepared.release();
    } finally {
      await test.dispose();
    }
  });

  it("reports inherited cancellation through waitpid and reaps the child", async () => {
    const test = createHarness();
    const controller = new AbortController();
    const child = test.spawn(controller.signal);
    controller.abort();

    try {
      await expect(test.host.exitStatus(child.handle)).resolves.toMatchObject({
        status: "error",
        error: { code: "CANCELLED" },
      });
      expect(test.host.processes.waitpid(undefined, child.pid)).toMatchObject({
        status: "error",
        error: { code: "CANCELLED" },
      });
      expect(test.host.processes.lookupPid(child.pid)).toMatchObject({
        status: "error",
        error: { code: "NOT_FOUND" },
      });
      expect(test.runner).not.toHaveBeenCalled();
      expect(() => child.childFilesystem.cwd).toThrow(expect.objectContaining({ code: "EBADF" }));
      await child.prepared.release();
    } finally {
      await test.dispose();
    }
  });

  it.each([9, 15])("preserves explicit signal %i as a real terminal status", async (signal) => {
    const test = createHarness();
    const child = test.spawn();

    try {
      expect(test.host.processes.signal(child.handle, signal)).toEqual({
        status: "ok",
        value: undefined,
      });
      await expect(test.host.exitStatus(child.handle)).resolves.toEqual({
        status: "ok",
        value: { exitCode: 0, signal, coreDumped: false },
      });
      expect(test.host.processes.wait(child.handle)).toEqual({
        status: "ok",
        value: { exitCode: 0 },
      });
      expect(test.host.processes.reap(child.handle)).toEqual({ status: "ok", value: undefined });
      expect(test.runner).not.toHaveBeenCalled();
      expect(() => child.childFilesystem.cwd).toThrow(expect.objectContaining({ code: "EBADF" }));
      await child.prepared.release();
    } finally {
      await test.dispose();
    }
  });
});
