import { describe, expect, it, vi } from "vite-plus/test";
import { KernelOpenFlags } from "./KernelFileSystem.ts";
import type {
  KernelAsyncProgramContext,
  KernelProgramAdmissionDecision,
  KernelProgramAdmissionRequest,
} from "./KernelProgramHost.ts";
import {
  asyncBinding,
  createAdmissionKernel,
  exitStatus,
} from "./tests/kernelProgramAdmissionFixture.ts";

describe("generic exec admission", () => {
  it("admits exec before the CLOEXEC sweep and runs the replacement once", async () => {
    const waiting = Promise.withResolvers<KernelProgramAdmissionDecision>();
    const execRequest = Promise.withResolvers<KernelProgramAdmissionRequest>();
    let cloexecFd = -1;
    let processId = -1;
    const replacement = vi.fn(async (context: KernelAsyncProgramContext) => {
      expect(context.filesystem.descriptors.has(cloexecFd)).toBe(false);
      expect(context.args).toEqual(["new-zero", "snow雪"]);
      expect(context.env).toEqual({ ONLY: "replacement" });
      return exitStatus(31);
    });
    const root = asyncBinding("root", async (context) => {
      processId = context.identity.pid;
      cloexecFd = context.filesystem.open(
        "/kept-until-exec",
        KernelOpenFlags.O_CREAT | KernelOpenFlags.O_WRONLY | KernelOpenFlags.O_CLOEXEC,
      );
      return context.exec({
        filesystem: context.filesystem,
        identity: context.identity,
        args: ["new-zero", "snow雪"],
        env: { ONLY: "replacement" },
        signal: context.signal,
        path: "/bin/replacement",
      });
    });
    const kernel = createAdmissionKernel(
      new Map([
        ["/bin/root", root],
        ["/bin/replacement", asyncBinding("replacement", replacement)],
      ]),
      {
        admit: async (request) => {
          if (request.command.executable === "/bin/root") return { kind: "local" };
          execRequest.resolve(request);
          return waiting.promise;
        },
      },
    );
    try {
      const process = await kernel.startRoot("/bin/root");
      const captured = await execRequest.promise;
      expect(captured.kind).toBe("exec");
      expect(captured.identity?.pid).toBe(processId);
      expect(captured.command).toMatchObject({
        executable: "/bin/replacement",
        argv: ["new-zero", "snow雪"],
        env: { ONLY: "replacement" },
      });
      expect(captured.filesystem.descriptors.has(cloexecFd)).toBe(true);
      expect(replacement).not.toHaveBeenCalled();
      expect(kernel.host.processes.size).toBe(1);

      waiting.resolve({
        kind: "local",
        onDispatch: (context) => {
          expect(context.identity.pid).toBe(processId);
          expect(context.filesystem.descriptors.has(cloexecFd)).toBe(false);
        },
      });
      await expect(kernel.host.exitStatus(process)).resolves.toEqual({
        status: "ok",
        value: exitStatus(31),
      });
      expect(replacement).toHaveBeenCalledOnce();
      expect(kernel.host.processes.size).toBe(1);
    } finally {
      await kernel.close();
    }
  });
});
