import { describe, expect, it, vi } from "vite-plus/test";
import { KernelOpenFlags } from "./KernelFileSystem.ts";
import type {
  KernelAsyncProgramContext,
  KernelProgramAdmissionDecision,
  KernelProgramAdmissionRequest,
} from "./KernelProgramHost.ts";
import type { AgentOsSpawnRequest } from "./AgentOsProcessWire.ts";
import {
  asyncBinding,
  createAdmissionKernel,
  exitStatus,
  readFile,
  seedFile,
  text,
} from "./tests/kernelProgramAdmissionFixture.ts";

function spawnRequest(
  execPath: string,
  options: Partial<Pick<AgentOsSpawnRequest, "argv" | "env" | "cwd" | "actions">> = {},
): AgentOsSpawnRequest {
  return {
    execPath,
    argv: options.argv ?? [execPath, "arg雪"],
    env: options.env ?? { EXACT: "value", EMPTY: "" },
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    actions: options.actions ?? [],
    attributes: {
      flags: 0,
      defaultMask: { low: 0, high: 0 },
      signalMask: { low: 0, high: 0 },
      processGroup: 0,
    },
    pidPointer: 0,
  };
}

describe("generic program admission", () => {
  it("waits before preparing descriptors, then runs one captured local request", async () => {
    const waiting = Promise.withResolvers<KernelProgramAdmissionDecision>();
    const admitted = Promise.withResolvers<KernelProgramAdmissionRequest>();
    const run = vi.fn(async (context: KernelAsyncProgramContext) => {
      context.filesystem.write(1, text("ran"), null);
      return exitStatus(23);
    });
    const onDispatch = vi.fn();
    const binding = asyncBinding("tool", run);
    const kernel = createAdmissionKernel(new Map([["/bin/tool", binding]]), {
      admit: vi.fn((request) => {
        admitted.resolve(request);
        return waiting.promise;
      }),
    });
    const parent = await kernel.startParent();
    const resolve = vi.spyOn(kernel.host, "resolve");
    try {
      seedFile(kernel.filesystem, "/result", "old data");
      const action = {
        kind: "open" as const,
        fd: 1,
        sourceFd: 0,
        flags: KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
        mode: 0o600,
        path: "/result",
      };
      const request = spawnRequest("/bin/tool", {
        argv: ["chosen-zero", "snow雪"],
        env: { TOKEN: "plain", EMPTY: "" },
        cwd: "/work",
        actions: [action],
      });
      const spawned = kernel.host.spawn(
        {
          filesystem: kernel.filesystem,
          parent: parent.handle,
          signal: new AbortController().signal,
          home: "/home/guest",
        },
        request,
      );

      const captured = await admitted.promise;
      expect(captured).toMatchObject({
        kind: "spawn",
        command: {
          executable: "/bin/tool",
          argv: request.argv,
          env: request.env,
          cwd: "/work",
        },
        baseCwd: "/",
        actions: [action],
        attributes: request.attributes,
        target: { kind: "resolved", program: binding.manifest, binding },
      });
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.isFrozen(captured.command.argv)).toBe(true);
      expect(kernel.host.processes.size).toBe(1);
      expect(resolve).toHaveBeenCalledOnce();
      expect(readFile(kernel.filesystem, "/result")).toBe("old data");
      expect(run).not.toHaveBeenCalled();

      waiting.resolve({ kind: "local", onDispatch });
      const result = await spawned;
      if (result.status !== "ok") throw new Error("Admitted spawn failed");
      await expect(kernel.host.exitStatus(result.value)).resolves.toEqual({
        status: "ok",
        value: exitStatus(23),
      });
      expect(run).toHaveBeenCalledOnce();
      expect(onDispatch).toHaveBeenCalledOnce();
      expect(onDispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          args: request.argv,
          env: request.env,
          home: "/home/guest",
        }),
      );
      expect(readFile(kernel.filesystem, "/result")).toBe("ran");
    } finally {
      parent.finish();
      await kernel.close();
    }
  });

  it("forwards an unsupported target once with its captured command and resulting cwd", async () => {
    const calls: unknown[] = [];
    const admitted = vi.fn(async (request: KernelProgramAdmissionRequest) => {
      expect(request.target).toEqual({
        kind: "unsupported",
        code: "NOT_FOUND",
        message: "Executable is not explicitly registered locally",
      });
      return {
        kind: "forward" as const,
        implementation: {
          kind: "async" as const,
          async run(context: KernelAsyncProgramContext) {
            calls.push({ args: context.args, env: context.env, cwd: context.filesystem.cwd });
            return exitStatus(29);
          },
        },
      };
    });
    const kernel = createAdmissionKernel(new Map(), { admit: admitted });
    const parent = await kernel.startParent();
    const resolve = vi.spyOn(kernel.host, "resolve");
    const request = spawnRequest("/opt/tool", {
      argv: ["alias", "one", "two"],
      env: { A: "1", B: "" },
      cwd: "/work",
      actions: [
        {
          kind: "chdir",
          fd: 0,
          sourceFd: 0,
          flags: 0,
          mode: 0,
          path: "/elsewhere",
        },
      ],
    });
    try {
      const result = await kernel.host.spawn(
        {
          filesystem: kernel.filesystem,
          parent: parent.handle,
          signal: new AbortController().signal,
        },
        request,
      );
      if (result.status !== "ok") throw new Error("Forwarded spawn failed");
      await expect(kernel.host.exitStatus(result.value)).resolves.toEqual({
        status: "ok",
        value: exitStatus(29),
      });
      expect(admitted).toHaveBeenCalledOnce();
      expect(resolve).toHaveBeenCalledOnce();
      expect(calls).toEqual([{ args: request.argv, env: request.env, cwd: "/elsewhere" }]);
    } finally {
      parent.finish();
      await kernel.close();
    }
  });

  it("cancels a grant that becomes stale without applying spawn actions", async () => {
    const cancel = vi.fn();
    const run = vi.fn(async (_context: KernelAsyncProgramContext) => exitStatus(0));
    const kernel = createAdmissionKernel(new Map([["/bin/tool", asyncBinding("tool", run)]]), {
      admit: async () => ({
        kind: "local",
        cancel,
        assertCurrent() {
          throw Object.assign(new Error("owner generation changed"), { code: "ECANCELED" });
        },
      }),
    });
    const parent = await kernel.startParent();
    seedFile(kernel.filesystem, "/result", "old data");
    const request = spawnRequest("/bin/tool", {
      actions: [
        {
          kind: "open",
          fd: 1,
          sourceFd: 0,
          flags: KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
          mode: 0o600,
          path: "/result",
        },
      ],
    });
    try {
      await expect(
        kernel.host.spawn(
          {
            filesystem: kernel.filesystem,
            parent: parent.handle,
            signal: new AbortController().signal,
          },
          request,
        ),
      ).rejects.toMatchObject({ code: "ECANCELED" });
      expect(cancel).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
      expect(kernel.host.processes.size).toBe(1);
      expect(readFile(kernel.filesystem, "/result")).toBe("old data");
    } finally {
      parent.finish();
      await kernel.close();
    }
  });

  it("releases a delayed grant if the parent signal aborts before it resumes", async () => {
    const waiting = Promise.withResolvers<KernelProgramAdmissionDecision>();
    const admitted = Promise.withResolvers<void>();
    const cancel = vi.fn();
    const run = vi.fn(async (_context: KernelAsyncProgramContext) => exitStatus(0));
    const kernel = createAdmissionKernel(new Map([["/bin/tool", asyncBinding("tool", run)]]), {
      admit: async () => {
        admitted.resolve();
        return waiting.promise;
      },
    });
    const parent = await kernel.startParent();
    seedFile(kernel.filesystem, "/result", "old data");
    const request = spawnRequest("/bin/tool", {
      actions: [
        {
          kind: "open",
          fd: 1,
          sourceFd: 0,
          flags: KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_TRUNC,
          mode: 0o600,
          path: "/result",
        },
      ],
    });
    const controller = new AbortController();
    try {
      const pending = kernel.host.spawn(
        { filesystem: kernel.filesystem, parent: parent.handle, signal: controller.signal },
        request,
      );
      await admitted.promise;
      controller.abort();
      waiting.resolve({ kind: "local", cancel });
      await expect(pending).resolves.toMatchObject({
        status: "error",
        error: { code: "CANCELLED" },
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(run).not.toHaveBeenCalled();
      expect(kernel.host.processes.size).toBe(1);
      expect(readFile(kernel.filesystem, "/result")).toBe("old data");
    } finally {
      parent.finish();
      await kernel.close();
    }
  });
});
