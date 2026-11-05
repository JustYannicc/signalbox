import { describe, expect, it } from "vite-plus/test";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createKernelProcessAdmissionPort } from "../../kernel/KernelProcessAdmissionPort.ts";
import { childBusyboxFixture } from "./ChildBusyboxFixture.ts";

const code = Object.freeze({ codeId: "process-capability", residentBytes: 0 });
const capacity = () =>
  new ChildWorkerCapacity(1, {
    owner: "test/process-capability",
    RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
  });
const topology = (parentPid = 1) => ({ scope: "kernel", parentPid });

describe("async process admission", () => {
  it("preserves arrival order when a later topology reply arrives first", async () => {
    const slots = capacity();
    const signal = new AbortController().signal;
    const firstReply = Promise.withResolvers<ReturnType<typeof topology>>();
    const secondReply = Promise.withResolvers<ReturnType<typeof topology>>();
    const secondReplied = Promise.withResolvers<void>();
    const requester = (describe: () => Promise<ReturnType<typeof topology>>) => ({
      owner: { describe, bind: async () => {} },
    });
    const order: string[] = [];
    const first = slots
      .acquire(
        signal,
        requester(() => firstReply.promise),
        code,
      )
      .then((permit) => {
        order.push("first");
        return permit;
      });
    const second = slots
      .acquire(
        signal,
        requester(async () => {
          const value = await secondReply.promise;
          secondReplied.resolve();
          return value;
        }),
        code,
      )
      .then((permit) => {
        order.push("second");
        return permit;
      });
    secondReply.resolve(topology());
    await secondReplied.promise;
    expect(slots.active).toBe(0);
    expect(order).toEqual([]);
    firstReply.resolve(topology());
    const one = await first;
    expect(order).toEqual(["first"]);
    await one.release();
    const two = await second;
    expect(order).toEqual(["first", "second"]);
    await two.release();
  });

  it("unblocks successors after topology failure and ignores a late cancelled reply", async () => {
    const slots = capacity();
    const signal = new AbortController().signal;
    const reply = Promise.withResolvers<ReturnType<typeof topology>>();
    const controller = new AbortController();
    const cancelled = slots.acquire(
      controller.signal,
      { owner: { describe: () => reply.promise, bind: async () => {} } },
      code,
    );
    const reason = new Error("cancel before topology");
    const rejected = expect(cancelled).rejects.toBe(reason);
    const next = slots.acquire(signal, undefined, code);
    controller.abort(reason);
    await rejected;
    const permit = await next;
    reply.resolve(topology());
    await permit.release();
    const failure = new Error("lost process RPC");
    await expect(
      slots.acquire(
        signal,
        {
          owner: {
            describe: async () => {
              throw failure;
            },
            bind: async () => {},
          },
        },
        code,
      ),
    ).rejects.toBe(failure);
    const recovered = await slots.acquire(signal, undefined, code);
    await recovered.release();
    expect(slots.active).toBe(0);
    expect(slots.waiting).toBe(0);
  });

  it("joins a pending bind and releases its permit on cancellation without dispatch", async () => {
    const slots = capacity();
    const controller = new AbortController();
    const binding = Promise.withResolvers<void>();
    const bound = Promise.withResolvers<void>();
    const requester = {
      owner: {
        describe: async () => topology(),
        bind: async () => {
          bound.resolve();
          await binding.promise;
        },
      },
    };
    let dispatched = false;
    const running = slots.run(
      controller.signal,
      async () => {
        dispatched = true;
      },
      requester,
      code,
    );
    await bound.promise;
    const reason = new Error("cancel during bind");
    const rejected = expect(running).rejects.toBe(reason);
    controller.abort(reason);
    expect(slots.active).toBe(1);
    binding.resolve();
    await rejected;
    expect(dispatched).toBe(false);
    expect(slots.active).toBe(0);
  });

  it("releases the reservation when the kernel rejects binding", async () => {
    const slots = capacity();
    const signal = new AbortController().signal;
    const failure = new Error("kernel handle was reaped");
    const requester = {
      owner: {
        describe: async () => topology(),
        bind: async () => {
          throw failure;
        },
      },
    };
    const reservation = await slots.reserve(signal, requester, code);
    await expect(
      reservation.run(
        signal,
        async () => {
          throw new Error("unexpected dispatch");
        },
        requester,
      ),
    ).rejects.toBe(failure);
    expect(slots.active).toBe(0);
  });

  it("shares sibling priority between local and capability requesters", async () => {
    const fixture = childBusyboxFixture();
    const slots = capacity();
    const signal = new AbortController().signal;
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const local = {
      processes: fixture.context.processes,
      process: fixture.context.identity.handle,
    };
    const owner = createKernelProcessAdmissionPort({ ...local, parentPid: 1, signal });
    const holding = slots.run(
      signal,
      async () => {
        entered.resolve();
        await finish.promise;
      },
      local,
      code,
    );
    try {
      await entered.promise;
      const order: string[] = [];
      const root = slots.acquire(signal, undefined, code).then((permit) => {
        order.push("root");
        return permit;
      });
      const sibling = slots.acquire(signal, { owner }, code).then((permit) => {
        order.push("sibling");
        return permit;
      });
      await owner.describe();
      finish.resolve();
      await holding;
      const first = await sibling;
      expect(order).toEqual(["sibling"]);
      await first.release();
      const last = await root;
      expect(order).toEqual(["sibling", "root"]);
      await last.release();
    } finally {
      finish.resolve();
      await holding;
      owner.close();
      await fixture.close();
    }
  });
});
