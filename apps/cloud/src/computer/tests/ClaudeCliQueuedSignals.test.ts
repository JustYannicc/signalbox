import { describe, expect, it, vi } from "vite-plus/test";
import { kernelError, kernelOk } from "../../kernel/KernelAbi.ts";
import type { KernelExitStatus } from "../../kernel/KernelProcessTable.ts";
import { cliFileBackendFixture as fixture } from "./helpers/cliFileBackend.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("CLI queued guest signals", () => {
  it("commits a later filesystem write after signalling a group with no live members", async () => {
    const f = await fixture();
    const completion = Promise.withResolvers<KernelExitStatus>();
    const child = f.processes.spawn(
      undefined,
      () => ({ completion: completion.promise, signal: () => kernelOk(undefined) }),
      () => {},
      { processGroupId: 0 },
    );
    if (child.status !== "ok") throw new Error("Child admission failed");
    try {
      completion.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      expect(await f.processes.terminateAndReap(child.value.handle)).toEqual(kernelOk(undefined));
      expect(f.files.signalProcess(-child.value.pid, 15)).toBeUndefined();
      f.fs.writeFileSync("/sync", "after signal");
      await f.files.barrier();
      expect(f.canonical.readFileSync("/sync", "utf8")).toBe("after signal");
      expect(await f.fs.promises.readFile("/sync", "utf8")).toBe("after signal");
    } finally {
      completion.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      await f.close();
    }
  });

  it.each([
    ["EXPIRED", undefined],
    ["PERMISSION_DENIED", "EPERM"],
    ["INVALID_ARGUMENT", "EINVAL"],
    ["IO_ERROR", "EIO"],
    ["INVALID_HANDLE", "ESRCH"],
  ] as const)("handles queued %s without losing real signal errors", async (code, nodeCode) => {
    const f = await fixture();
    const completion = Promise.withResolvers<KernelExitStatus>();
    const delivered = vi.fn(() => kernelError(code, "Group signal failed"));
    const child = f.processes.spawn(
      undefined,
      () => ({ completion: completion.promise, signal: delivered }),
      () => {},
      { processGroupId: 0 },
    );
    if (child.status !== "ok") throw new Error("Child admission failed");
    try {
      expect(f.files.signalProcess(-child.value.pid, 15)).toBeUndefined();
      f.fs.writeFileSync("/sync", "after signal");
      if (nodeCode === undefined) {
        await f.files.barrier();
        expect(f.canonical.readFileSync("/sync", "utf8")).toBe("after signal");
      } else {
        await expect(f.files.barrier()).rejects.toMatchObject({ code: nodeCode });
        expect(f.canonical.readFileSync("/sync", "utf8")).toBe("before");
        await expect(f.fs.promises.readFile("/sync")).rejects.toMatchObject({ code: nodeCode });
      }
      expect(delivered).toHaveBeenCalledExactlyOnceWith(15);
    } finally {
      completion.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      await completion.promise;
      if (nodeCode === undefined) await f.close();
      else
        await expect(f.close()).rejects.toMatchObject({ message: "CLI filesystem cleanup failed" });
    }
  });
});
