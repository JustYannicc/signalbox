import { describe, expect, it, vi } from "vite-plus/test";
import { ChildHostLease } from "../ChildHostLease.ts";
import { createWorkerBashHost } from "../WorkerBashHost.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const argsSizes = {
  name: "args_sizes_get",
  args: [0, 4],
  memorySize: 8,
  regions: [{ pointer: 0, bytes: new Uint8Array(8) }],
};

describe("Worker Bash host", () => {
  it("releases a completed fork before its command closes while the root keeps working", async () => {
    const fixture = childBashFixture();
    const lease = new ChildHostLease();
    const worker = createWorkerBashHost(
      { context: fixture.context, credentials: bashCredentials },
      lease,
    );
    try {
      const child = await worker.host.fork();
      if (child.kind !== "fork") throw new Error("Fork failed");
      await expect(child.port.call(argsSizes)).resolves.toMatchObject({ value: 0 });
      await child.port.complete({ kind: "exit", status: exited(3) });

      await expect(child.port.call(argsSizes)).rejects.toMatchObject({ code: "EBADF" });
      await expect(worker.host.wait(child.pid, 0)).resolves.toEqual({
        kind: "wait",
        pid: child.pid,
        status: exited(3),
      });
      await expect(worker.host.call(argsSizes)).resolves.toMatchObject({ value: 0 });
    } finally {
      lease.release();
      await worker.close();
      await fixture.close();
    }
  });
});
