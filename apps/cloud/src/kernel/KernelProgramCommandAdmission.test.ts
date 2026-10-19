import { describe, expect, it, vi } from "vite-plus/test";
import { ABI_VERSION, KernelProgramRegistry, KernelWakeRegistry } from "./KernelAbi.ts";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import { createFacetSqliteStorage } from "./FacetSqliteStorage.ts";
import { KernelCommandExecutor } from "./KernelCommandExecutor.ts";
import { canonicalFileByteSelection, type KernelFileByteView } from "./KernelFileBytes.ts";
import { KernelFileSystem, KernelOpenFlags } from "./KernelFileSystem.ts";
import { KernelProgramHost, type KernelProgramBinding } from "./KernelProgramHost.ts";
import { sqliteFixture } from "./tests/sqliteFixture.ts";
import { createKernelProcessStreams } from "./KernelProcessStreams.ts";
import type {
  KernelProgramAdmissionDecision,
  KernelProgramAdmissionRequest,
} from "./KernelProgramAdmission.ts";
import {
  asyncBinding,
  createAdmissionKernel,
  exitStatus,
  readFile,
  seedFile,
  text,
} from "./tests/kernelProgramAdmissionFixture.ts";

const command = () => ({
  executable: "/bin/tool",
  argv: ["chosen-zero", "snow雪"],
  cwd: "/work",
  env: { EXACT: "raw", EMPTY: "" },
});

describe("admitted piped commands", () => {
  it("selects trusted file bytes once, honors an explicit canonical binding and rejects incompatible inherited files", async () => {
    const database = sqliteFixture();
    const storage = createFacetSqliteStorage(database.storage, () => 1n);
    const filesystem = new KernelFileSystem({ mounts: [{ path: "/", storage }] });
    seedFile(filesystem, "/file", "canonical");
    const selected = text("selected bytes");
    const view: KernelFileByteView = {
      completion: "sync",
      storage,
      bind(inode) {
        return {
          stat: () => ({ ...storage.stat(inode), size: BigInt(selected.length) }),
          readInto(offset, target) {
            const bytes = selected.subarray(Number(offset), Number(offset) + target.length);
            target.set(bytes);
            return bytes.length;
          },
          write: (offset, bytes) => storage.write(inode, offset, bytes),
          append: (bytes) => storage.append(inode, bytes),
          truncate: (size) => storage.truncate(inode, size),
          sync: (dataOnly) => storage.sync(inode, dataOnly),
          release() {},
        };
      },
    };
    const run = vi.fn(({ filesystem }: { filesystem: KernelFileSystem }) => {
      const bytes = text(readFile(filesystem, "/file"));
      filesystem.write(1, bytes, null);
      return 0;
    });
    const binding: KernelProgramBinding = {
      manifest: {
        name: "reader",
        version: "1",
        abiVersion: ABI_VERSION,
        entrypoint: "reader",
        requiredCapabilities: [],
      },
      implementation: { kind: "javascript", runInline: run },
    };
    const registry = new KernelProgramRegistry();
    registry.register(binding.manifest);
    const wakes = new KernelWakeRegistry();
    const selector = vi.fn(() => ({ kind: "view" as const, view }));
    const cancel = vi.fn();
    const host = new KernelProgramHost({
      registry,
      wakes,
      programs: new Map([["/bin/tool", binding]]),
      selectFileBytes: selector,
      admit: async () => ({ kind: "local", cancel }),
    });
    const shared = {
      host,
      filesystem,
      admitted: true as const,
      forwarder: {
        async spawn(): Promise<never> {
          throw new Error("Unexpected fallback");
        },
      },
    };
    try {
      for (const [options, expected] of [
        [{ fileBytes: canonicalFileByteSelection }, "canonical"],
        [{}, "selected bytes"],
      ] as const) {
        const child = await new KernelCommandExecutor({ ...shared, ...options }).spawn(
          { ...command(), cwd: "/" },
          new AbortController().signal,
        );
        try {
          const [output, error, status] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
          ]);
          expect({ output, error, status }).toEqual({
            output: expected,
            error: "",
            status: exitStatus(0),
          });
        } finally {
          await child.dispose();
        }
      }
      expect(selector).toHaveBeenCalledOnce();
      const inherited = filesystem.open("/file", KernelOpenFlags.O_RDONLY);
      const cancellations = cancel.mock.calls.length;
      await expect(
        new KernelCommandExecutor(shared).spawn(
          { ...command(), cwd: "/" },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "UNSUPPORTED" });
      expect(run).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledTimes(cancellations + 1);
      expect(filesystem.fileBytes).toBe(canonicalFileByteSelection);
      expect(readFile(filesystem, "/file")).toBe("canonical");
      filesystem.close(inherited);
    } finally {
      await host.processes.dispose();
      wakes.dispose();
      filesystem.dispose();
      database.close();
    }
  });

  it("captures once before descriptors and dispatches the same frozen context with raw env", async () => {
    const admitted = Promise.withResolvers<KernelProgramAdmissionRequest>();
    const waiting = Promise.withResolvers<KernelProgramAdmissionDecision>();
    const onDispatch = vi.fn();
    const run = vi.fn(async (context: KernelAsyncProgramContext) => {
      expect(onDispatch).toHaveBeenCalledWith(context);
      expect(Object.isFrozen(context)).toBe(true);
      expect(context.env).toEqual({ EXACT: "raw", EMPTY: "" });
      expect(context.env.HOME).toBeUndefined();
      expect(context.filesystem.cwd).toBe("/work");
      const writer = createKernelProcessStreams(context.filesystem).stdout.getWriter();
      await writer.write(text("result"));
      writer.releaseLock();
      return exitStatus(23);
    });
    const selector = vi.fn(() => canonicalFileByteSelection);
    const kernel = createAdmissionKernel(new Map([["/bin/tool", asyncBinding("tool", run)]]), {
      selectFileBytes: selector,
      admit: (request) => {
        admitted.resolve(request);
        return waiting.promise;
      },
    });
    const fork = vi.spyOn(kernel.filesystem.descriptors, "fork");
    const resolve = vi.spyOn(kernel.host, "resolve");
    const raw = command();
    const forwarder = {
      spawn: vi.fn(async (): Promise<never> => {
        throw new Error("fallback");
      }),
    };
    const executor = new KernelCommandExecutor({
      host: kernel.host,
      filesystem: kernel.filesystem,
      forwarder,
      admitted: true,
      home: "/home/guest",
    });
    try {
      const pending = executor.spawn(raw, new AbortController().signal);
      const request = await admitted.promise;
      expect(request).toMatchObject({
        kind: "command",
        stdio: "piped",
        baseCwd: "/",
        home: "/home/guest",
        command: command(),
        actions: [],
        attributes: undefined,
      });
      expect(request.parent).toBeUndefined();
      expect(Object.isFrozen(request.command.env)).toBe(true);
      expect(fork).not.toHaveBeenCalled();
      expect(selector).toHaveBeenCalledOnce();
      raw.argv[0] = "changed";
      raw.env.EXACT = "changed";
      raw.cwd = "/elsewhere";
      raw.executable = "/other";
      kernel.filesystem.chdir("/elsewhere");
      waiting.resolve({ kind: "local", onDispatch });
      const child = await pending;
      try {
        const [output, error, status] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect({ output, error, status }).toEqual({
          output: "result",
          error: "",
          status: exitStatus(23),
        });
      } finally {
        await child.dispose();
      }
      const context = run.mock.calls[0]?.[0];
      expect(context?.args).toEqual(command().argv);
      expect(fork).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledOnce();
      expect(selector).toHaveBeenCalledOnce();
      expect(kernel.host.processes.size).toBe(0);
      expect(forwarder.spawn).not.toHaveBeenCalled();
    } finally {
      await kernel.close();
    }
  });

  it.each(["abort", "prepare", "stale", "launch"] as const)(
    "cancels an unused %s grant once and preserves the owner fd table",
    async (failure) => {
      const admitted = Promise.withResolvers<void>();
      const waiting = Promise.withResolvers<KernelProgramAdmissionDecision>();
      const cancel = vi.fn();
      const run = vi.fn(async () => exitStatus(0));
      const kernel = createAdmissionKernel(new Map([["/bin/tool", asyncBinding("tool", run)]]), {
        ...(failure === "launch" ? { maxProcesses: 1 } : {}),
        admit: () => {
          admitted.resolve();
          return waiting.promise;
        },
      });
      const parent = failure === "launch" ? await kernel.startParent() : undefined;
      const controller = new AbortController();
      const fork = vi.spyOn(kernel.filesystem.descriptors, "fork");
      seedFile(kernel.filesystem, "/work/out", "unchanged");
      const before = [...kernel.filesystem.descriptors.entries()];
      const pending = kernel.host.spawnCommandPiped(
        { filesystem: kernel.filesystem, signal: controller.signal },
        { ...command(), ...(failure === "prepare" ? { cwd: "/missing" } : {}) },
      );
      try {
        await admitted.promise;
        if (failure === "abort") controller.abort();
        waiting.resolve({
          kind: "local",
          cancel,
          ...(failure === "stale"
            ? {
                assertCurrent() {
                  throw new Error("stale grant");
                },
              }
            : {}),
        });
        if (failure === "stale") await expect(pending).rejects.toThrow("stale grant");
        else
          await expect(pending).resolves.toMatchObject({
            status: "error",
            error: {
              code:
                failure === "abort"
                  ? "CANCELLED"
                  : failure === "launch"
                    ? "RESOURCE_LIMIT"
                    : "IO_ERROR",
            },
          });
        expect(cancel).toHaveBeenCalledOnce();
        expect(fork).toHaveBeenCalledTimes(failure === "prepare" || failure === "launch" ? 1 : 0);
        expect([...kernel.filesystem.descriptors.entries()]).toEqual(before);
        expect(readFile(kernel.filesystem, "/work/out")).toBe("unchanged");
        expect(kernel.host.processes.size).toBe(parent === undefined ? 0 : 1);
        expect(run).not.toHaveBeenCalled();
      } finally {
        parent?.finish();
        await kernel.close();
      }
    },
  );

  it("does not forward a missing target when its sole admission decision selects local", async () => {
    const cancel = vi.fn();
    const admit = vi.fn(async () => ({ kind: "local" as const, cancel }));
    const kernel = createAdmissionKernel(new Map(), { admit });
    const forwarder = {
      spawn: vi.fn(async (): Promise<never> => {
        throw new Error("fallback");
      }),
    };
    const executor = new KernelCommandExecutor({
      host: kernel.host,
      filesystem: kernel.filesystem,
      forwarder,
      admitted: true,
    });
    try {
      await expect(executor.spawn(command(), new AbortController().signal)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      expect(admit).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(forwarder.spawn).not.toHaveBeenCalled();
    } finally {
      await kernel.close();
    }
  });
});
