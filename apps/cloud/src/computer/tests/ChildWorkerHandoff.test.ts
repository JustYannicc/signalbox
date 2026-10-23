import { describe, expect, it, vi } from "vite-plus/test";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { ChildWorkerDispatchError } from "../ChildWorkerDispatchError.ts";
import { createChildWorkerProgram } from "../ChildWorkerProgram.ts";
import { ChildHostLease } from "../ChildHostLease.ts";
import { createWorkerBashForkHost } from "../WorkerBashHost.ts";
import { createKernelBashHost } from "../../kernel/KernelBashHost.ts";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import { childBusyboxFixture } from "./ChildBusyboxFixture.ts";
import { bashCredentials } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("child slot handoff", () => {
  it("waits for a disconnected Worker's stop ACK before handing its slot off", async () => {
    const fixture = childBusyboxFixture();
    const capacity = new ChildWorkerCapacity(1, {
      owner: "test/src-computer-tests-childworkerhandoff-test-1",
    });
    const cleaned = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const handedOff = Promise.withResolvers<void>();
    let handoffs = 0;
    const failure = new ChildWorkerDispatchError(new Error("disconnected"), {
      kind: "unconfirmed",
      stopped: stopped.promise,
    });
    const program = createChildWorkerProgram({
      executable: "/bin/tool",
      code: { mainModule: "main.js", modules: {} },
      capacity,
      dispatch: {
        async run() {
          throw failure;
        },
      },
      createHost(_context, _lease, execution) {
        return {
          host: {},
          close() {
            cleaned.resolve();
          },
          async onStopped() {
            await execution.handoff();
            handoffs++;
            handedOff.resolve();
          },
        };
      },
    });
    try {
      await expect(program.run(fixture.context)).rejects.toBe(failure);
      await cleaned.promise;
      expect(handoffs).toBe(0);
      expect(capacity.active).toBe(1);
      stopped.resolve();
      await handedOff.promise;
      await program.drain();
      expect(handoffs).toBe(1);
      expect(capacity.active).toBe(0);
    } finally {
      stopped.resolve();
      await fixture.close();
    }
  });

  it("revokes an already-exported checkpoint capability when its Worker lease closes", async () => {
    const fixture = childBusyboxFixture();
    const owner = createKernelBashHost({ context: fixture.context, credentials: bashCredentials });
    const lease = new ChildHostLease();
    const source: KernelBashForkSource = {
      state: vi.fn(),
      read: vi.fn(),
      restored: vi.fn(),
    };
    const bridge = createWorkerBashForkHost(
      { context: fixture.context, credentials: bashCredentials },
      lease,
      owner,
      source,
    );
    try {
      const exported = bridge.host.forkSnapshot();
      expect(exported).toBeDefined();
      lease.release();
      expect(() => exported!.state()).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(source.state).not.toHaveBeenCalled();
    } finally {
      await owner.close();
      await fixture.close();
    }
  });

  it("releases the parent's fork-source stub as soon as restoration is acknowledged", async () => {
    const fixture = childBusyboxFixture();
    const owner = createKernelBashHost({ context: fixture.context, credentials: bashCredentials });
    const lease = new ChildHostLease();
    const dispose = vi.fn();
    const restored = vi.fn(async () => {});
    const source = {
      state: vi.fn(),
      read: vi.fn(),
      restored,
      [Symbol.dispose]: dispose,
    };
    const bridge = createWorkerBashForkHost(
      { context: fixture.context, credentials: bashCredentials },
      lease,
      owner,
      source,
    );
    try {
      const exported = bridge.host.forkSnapshot();
      await exported!.restored();
      expect(restored).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect(() => exported!.state()).toThrow(expect.objectContaining({ code: "EBADF" }));
      lease.release();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      lease.release();
      await owner.close();
      await fixture.close();
    }
  });
});
