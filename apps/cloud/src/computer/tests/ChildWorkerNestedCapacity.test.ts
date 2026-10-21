import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelProcessIdentity } from "../../kernel/KernelProcessTable.ts";
import { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { ChildWorkerCapacity, type ChildWorkerRequester } from "../ChildWorkerCapacity.ts";

function processTree() {
  const wakes = new KernelWakeRegistry();
  const processes = new KernelProcessTable({ wakes });
  const completion = Promise.withResolvers<{
    exitCode: number;
    signal: number;
    coreDumped: boolean;
  }>();
  return {
    processes,
    spawn(parent?: KernelProcessIdentity) {
      const child = processes.spawn(
        parent?.handle,
        () => ({
          completion: completion.promise,
          signal: () => ({ status: "ok", value: undefined }),
        }),
        () => {},
      );
      if (child.status !== "ok") throw new Error("Test process could not start");
      return { identity: child.value, processes, process: child.value.handle };
    },
    async close() {
      completion.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      await processes.dispose();
      wakes.dispose();
    },
  };
}

async function hold(capacity: ChildWorkerCapacity, requester: ChildWorkerRequester) {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const running = capacity.run(
    new AbortController().signal,
    async () => {
      entered.resolve();
      await finish.promise;
    },
    requester,
  );
  await entered.promise;
  return async () => {
    finish.resolve();
    await running;
  };
}

describe("nested child worker capacity", () => {
  it("completes when every soft-limit holder waits for its own child", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity();
    const signal = new AbortController().signal;
    const full = Promise.withResolvers<void>();
    let roots = 0;
    let children = 0;
    try {
      const commands = Array.from({ length: capacity.limit }, (_, index) => {
        const parent = tree.spawn();
        const child = tree.spawn(parent.identity);
        return capacity.run(
          signal,
          async () => {
            if (++roots === capacity.limit) full.resolve();
            await full.promise;
            return capacity.run(
              signal,
              async () => {
                children++;
                return index;
              },
              child,
            );
          },
          parent,
        );
      });
      expect(await Promise.all(commands)).toEqual(
        Array.from({ length: capacity.limit }, (_, index) => index),
      );
      expect(children).toBe(capacity.limit);
      expect(capacity.active).toBe(0);
    } finally {
      await tree.close();
    }
  });

  it("walks through an unpermitted parent to its holder", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(1);
    const holder = tree.spawn();
    const middle = tree.spawn(holder.identity);
    const child = tree.spawn(middle.identity);
    const release = await hold(capacity, holder);
    const info = vi.spyOn(tree.processes, "info");
    try {
      await capacity.run(
        new AbortController().signal,
        async () => {
          expect(capacity.active).toBe(2);
        },
        child,
      );
      // One lookup starts the walk; one binds the admitted child. Parents reuse lookupPid.info.
      expect(info).toHaveBeenCalledTimes(2);
    } finally {
      await release();
      await tree.close();
    }
    expect(capacity.active).toBe(0);
  });

  it("includes the requester itself and refcounts an exec replacement sharing its pid", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(1);
    const signal = new AbortController().signal;
    const holder = tree.spawn();
    const child = tree.spawn(holder.identity);
    const release = await hold(capacity, holder);
    const finish = Promise.withResolvers<void>();
    let running: Promise<void> | undefined;
    try {
      const replacement = await capacity.reserve(signal, holder);
      running = replacement.run(signal, () => finish.promise, holder.identity.pid);
      expect(capacity.active).toBe(2);
      await release();
      await capacity.run(
        signal,
        async () => {
          expect(capacity.active).toBe(2);
        },
        child,
      );
    } finally {
      finish.resolve();
      await running;
      await release();
      await tree.close();
    }
    expect(capacity.active).toBe(0);
  });

  it("does not mistake another process table's matching pid for a permit holder", async () => {
    const first = processTree();
    const second = processTree();
    const capacity = new ChildWorkerCapacity(1);
    const holder = first.spawn();
    const unrelated = second.spawn();
    expect(unrelated.identity.pid).toBe(holder.identity.pid);
    const release = await hold(capacity, holder);
    try {
      const next = capacity.acquire(new AbortController().signal, unrelated);
      expect(capacity.active).toBe(1);
      await release();
      const permit = await next;
      permit.release();
    } finally {
      await release();
      await first.close();
      await second.close();
    }
    expect(capacity.active).toBe(0);
  });

  it("queues past the hard limit FIFO and gives descendants priority over queued roots", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(1, { hardLimit: 3 });
    const signal = new AbortController().signal;
    const parent = tree.spawn();
    const requester = { processes: tree.processes, process: parent.identity.handle };
    try {
      const release = await hold(capacity, parent);
      const [firstOverflow, secondOverflow] = await Promise.all([
        capacity.acquire(signal, requester),
        capacity.acquire(signal, requester),
      ]);
      const order: string[] = [];
      const root = capacity.acquire(signal).then((permit) => {
        order.push("root");
        return permit;
      });
      const first = capacity.acquire(signal, requester).then((permit) => {
        order.push("first");
        return permit;
      });
      const second = capacity.acquire(signal, requester).then((permit) => {
        order.push("second");
        return permit;
      });
      expect(capacity.active).toBe(3);
      expect(order).toEqual([]);
      firstOverflow.release();
      const firstPermit = await first;
      expect(capacity.active).toBe(3);
      expect(order).toEqual(["first"]);
      firstPermit.release();
      const secondPermit = await second;
      expect(capacity.active).toBe(3);
      expect(order).toEqual(["first", "second"]);
      secondPermit.release();
      secondOverflow.release();
      expect(capacity.active).toBe(1);
      await release();
      const rootPermit = await root;
      expect(order).toEqual(["first", "second", "root"]);
      rootPermit.release();
      expect(capacity.active).toBe(0);
    } finally {
      await tree.close();
    }
  });

  it("removes an aborted descendant from the hard-limit queue without blocking its successor", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(1, { hardLimit: 1 });
    const parent = tree.spawn();
    const requester = { processes: tree.processes, process: parent.identity.handle };
    const signal = new AbortController().signal;
    try {
      const release = await hold(capacity, parent);
      const controller = new AbortController();
      const cancelled = capacity.reserve(controller.signal, requester);
      const next = capacity.reserve(signal, requester);
      const reason = { cancelled: "nested request" };
      const rejected = expect(cancelled).rejects.toBe(reason);
      controller.abort(reason);
      await rejected;
      await release();
      const reservation = await next;
      await expect(reservation.run(signal, async () => 17)).resolves.toBe(17);
      expect(capacity.active).toBe(0);
    } finally {
      await tree.close();
    }
  });
});
