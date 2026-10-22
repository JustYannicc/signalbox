import { describe, expect, it } from "vite-plus/test";
import { kernelOk } from "./KernelAbi.ts";
import { KernelProcessSignal } from "./KernelProcessSignal.ts";
import type { KernelExitStatus } from "./KernelProcessTable.ts";
import { createAdmissionKernel, exitStatus } from "./tests/kernelProgramAdmissionFixture.ts";

const blockedSigpipe = { low: 4096, high: 0 };

describe("SIGPIPE fork state", () => {
  it.each(["terminate", "epipe"] as const)(
    "inherits %s and the mask without pending signals",
    async (sigpipe) => {
      const kernel = createAdmissionKernel(new Map());
      const parent = await kernel.startParent();
      const completion = Promise.withResolvers<KernelExitStatus>();
      try {
        expect(kernel.host.processes.setSigpipeDisposition(parent.handle, sigpipe).status).toBe(
          "ok",
        );
        expect(kernel.host.processes.signalMask(parent.handle, 0, blockedSigpipe).status).toBe(
          "ok",
        );
        expect(kernel.host.processes.generateSignal(parent.handle, 13).status).toBe("ok");
        const child = kernel.host.processes.spawn(
          parent.handle,
          () => ({
            completion: completion.promise,
            signal: () => {
              completion.resolve(exitStatus(0));
              return kernelOk(undefined);
            },
          }),
          () => {},
        );
        if (child.status !== "ok") throw new Error("Child admission failed");
        expect(kernel.host.processes.signalMask(child.value.handle, 3)).toEqual({
          status: "ok",
          value: blockedSigpipe,
        });
        expect(kernel.host.processes.signalMask(child.value.handle, 1, blockedSigpipe).status).toBe(
          "ok",
        );
        const generate = () => kernel.host.processes.generateSignal(child.value.handle, 13);
        if (sigpipe === "epipe") expect(generate()).toEqual(kernelOk(undefined));
        else expect(generate).toThrow(KernelProcessSignal);
        expect(kernel.host.processes.signalMask(parent.handle, 3)).toEqual({
          status: "ok",
          value: blockedSigpipe,
        });
      } finally {
        completion.resolve(exitStatus(0));
        parent.finish();
        await kernel.close();
      }
    },
  );

  it("discards an unblocked ignored signal before a later default disposition", async () => {
    const kernel = createAdmissionKernel(new Map());
    const parent = await kernel.startParent();
    try {
      expect(kernel.host.processes.setSigpipeDisposition(parent.handle, "epipe").status).toBe("ok");
      expect(kernel.host.processes.generateSignal(parent.handle, 13).status).toBe("ok");
      expect(kernel.host.processes.setSigpipeDisposition(parent.handle, "terminate").status).toBe(
        "ok",
      );
      expect(kernel.host.processes.signalMask(parent.handle, 1, blockedSigpipe).status).toBe("ok");
    } finally {
      parent.finish();
      await kernel.close();
    }
  });
});
