import { describe, expect, it } from "vite-plus/test";
import { KernelProcessTable } from "./KernelProcessTable.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { createKernelProcessAdmissionPort } from "./KernelProcessAdmissionPort.ts";

describe("kernel process admission capability", () => {
  it("inherits admission identity through the existing table and revokes only the capability", async () => {
    const wakes = new KernelWakeRegistry();
    const processes = new KernelProcessTable({ wakes });
    const done = Promise.withResolvers<{ exitCode: number; signal: number; coreDumped: boolean }>();
    const spawn = (parent?: Parameters<KernelProcessTable["spawn"]>[0]) => {
      const result = processes.spawn(
        parent,
        () => ({ completion: done.promise, signal: () => ({ status: "ok", value: undefined }) }),
        () => {},
      );
      if (result.status !== "ok") throw new Error("Fixture process could not start");
      return result.value;
    };
    const signal = new AbortController().signal;
    const parent = spawn();
    const owner = createKernelProcessAdmissionPort({ processes, process: parent.handle, signal });
    try {
      await owner.bind("lease-one");
      const child = spawn(parent.handle);
      const descendant = createKernelProcessAdmissionPort({
        processes,
        process: child.handle,
        signal,
      });
      expect(await descendant.describe()).toEqual({
        scope: processes.admissionScope,
        parentPid: parent.pid,
        owner: "lease-one",
      });
      descendant.close();
      await expect(descendant.describe()).rejects.toMatchObject({ code: "EBADF" });
      await expect(descendant.bind("late")).rejects.toMatchObject({ code: "EBADF" });
      expect(processes.info(child.handle)).toMatchObject({ status: "ok" });
      expect(await owner.describe()).toMatchObject({ owner: "lease-one" });
    } finally {
      owner.close();
      done.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      await processes.dispose();
      wakes.dispose();
    }
  });

  it("checks cancellation before changing the authoritative process record", async () => {
    const wakes = new KernelWakeRegistry();
    const processes = new KernelProcessTable({ wakes });
    const controller = new AbortController();
    const owner = createKernelProcessAdmissionPort({
      processes,
      process: undefined,
      signal: controller.signal,
    });
    const reason = new Error("owner cancelled");
    controller.abort(reason);
    try {
      await expect(owner.bind("late")).rejects.toBe(reason);
      await expect(owner.describe()).rejects.toBe(reason);
      expect(processes.admissionOwner(undefined)).toEqual({ status: "ok", value: undefined });
    } finally {
      owner.close();
      await processes.dispose();
      wakes.dispose();
    }
  });
});
