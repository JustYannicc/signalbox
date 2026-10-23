import { describe, expect, it } from "vite-plus/test";
import type { KernelProcessIdentity } from "../../kernel/KernelProcessTable.ts";
import { KernelProcessTable } from "../../kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../kernel/KernelWakeRegistry.ts";
import { ChildWorkerCapacity, type ChildWorkerRequester } from "../ChildWorkerCapacity.ts";

const syntheticRequest = Object.freeze({ codeId: "test-holder", residentBytes: 0 });

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
    spawn(parent?: KernelProcessIdentity, exited = completion.promise) {
      const child = processes.spawn(
        parent?.handle,
        () => ({
          completion: exited,
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
    syntheticRequest,
  );
  await entered.promise;
  return async () => {
    finish.resolve();
    await running;
  };
}

describe("nested child worker capacity", () => {
  it("keeps nested requests under the strict cap and admits them before queued roots", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(1);
    const signal = new AbortController().signal;
    const parent = tree.spawn();
    const release = await hold(capacity, parent);
    const child = tree.spawn(parent.identity);
    const order: string[] = [];
    try {
      const nested = capacity
        .acquire(
          signal,
          {
            processes: tree.processes,
            process: child.identity.handle,
          },
          syntheticRequest,
        )
        .then((permit) => {
          order.push("nested");
          return permit;
        });
      const root = capacity.acquire(signal, undefined, syntheticRequest).then((permit) => {
        order.push("root");
        return permit;
      });

      expect(capacity.active).toBe(capacity.limit);
      expect(order).toEqual([]);
      await release();

      const nestedPermit = await nested;
      expect(capacity.active).toBeLessThanOrEqual(capacity.limit);
      expect(order).toEqual(["nested"]);
      nestedPermit.release();

      const rootPermit = await root;
      expect(capacity.active).toBeLessThanOrEqual(capacity.limit);
      expect(order).toEqual(["nested", "root"]);
      rootPermit.release();
      expect(capacity.active).toBe(0);
    } finally {
      await release();
      await tree.close();
    }
  });

  it("admits a background continuation after its subshell exits and is reaped", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(1);
    const holder = tree.spawn();
    const release = await hold(capacity, holder);
    const subshellExit = Promise.withResolvers<{
      exitCode: number;
      signal: number;
      coreDumped: boolean;
    }>();
    const subshell = tree.spawn(holder.identity, subshellExit.promise);
    const continuation = tree.spawn(subshell.identity);
    const controller = new AbortController();
    let running: Promise<number> | undefined;
    try {
      subshellExit.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      expect(await tree.processes.terminateAndReap(subshell.identity.handle)).toEqual({
        status: "ok",
        value: undefined,
      });
      expect(tree.processes.info(continuation.identity.handle)).toMatchObject({
        status: "ok",
        value: { parentPid: 1 },
      });
      running = capacity.run(controller.signal, async () => 17, continuation, syntheticRequest);
      void running.catch(() => undefined);
      expect(capacity.active).toBe(capacity.limit);
      await release();
      await expect(running).resolves.toBe(17);
    } finally {
      controller.abort();
      await running?.catch(() => undefined);
      await release();
      await tree.close();
    }
  });

  it("inherits worker ownership through an unpermitted process", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(1);
    const holder = tree.spawn();
    const release = await hold(capacity, holder);
    const middle = tree.spawn(holder.identity);
    const child = tree.spawn(middle.identity);
    let started = false;
    let queued: Promise<void> | undefined;
    try {
      queued = capacity.run(
        new AbortController().signal,
        async () => {
          started = true;
        },
        child,
        syntheticRequest,
      );
      expect(started).toBe(false);
      expect(capacity.active).toBe(capacity.limit);
      await release();
      await queued;
      expect(started).toBe(true);
    } finally {
      await release();
      await queued?.catch(() => undefined);
      await tree.close();
    }
    expect(capacity.active).toBe(0);
  });

  it("gives an exec replacement its own owner until that worker settles", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(1);
    const signal = new AbortController().signal;
    const holder = tree.spawn();
    const release = await hold(capacity, holder);
    const finish = Promise.withResolvers<void>();
    let running: Promise<void> | undefined;
    try {
      const replacementQueued = capacity.reserve(signal, holder, syntheticRequest);
      const child = tree.spawn(holder.identity);
      let childStarted = false;
      const childQueued = capacity.run(
        signal,
        async () => {
          childStarted = true;
        },
        child,
        syntheticRequest,
      );
      expect(capacity.active).toBe(capacity.limit);
      await release();
      const replacement = await replacementQueued;
      running = replacement.run(signal, () => finish.promise, holder);
      await Promise.resolve();
      expect(childStarted).toBe(false);
      expect(capacity.active).toBe(capacity.limit);
      finish.resolve();
      await running;
      await childQueued;
      expect(childStarted).toBe(true);
      expect(capacity.active).toBe(0);
    } finally {
      finish.resolve();
      await running?.catch(() => undefined);
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
      const next = capacity.acquire(new AbortController().signal, unrelated, syntheticRequest);
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

  it("treats descendants of a stopped worker as roots", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(1);
    const holder = tree.spawn();
    const release = await hold(capacity, holder);
    const child = tree.spawn(holder.identity);
    await release();
    const held = await capacity.acquire(new AbortController().signal, undefined, syntheticRequest);
    const controller = new AbortController();
    const queued = capacity.acquire(controller.signal, child, syntheticRequest);
    const reason = new Error("cancel stale owner request");
    const rejected = expect(queued).rejects.toBe(reason);
    try {
      expect(capacity.active).toBe(1);
      controller.abort(reason);
      await rejected;
    } finally {
      held.release();
      await tree.close();
    }
  });

  it("keeps the strict cap and serves queued descendants before roots", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(1);
    const signal = new AbortController().signal;
    const parent = tree.spawn();
    try {
      const release = await hold(capacity, parent);
      const child = tree.spawn(parent.identity);
      const nestedRequester = { processes: tree.processes, process: child.identity.handle };
      const order: string[] = [];
      const root = capacity.acquire(signal, undefined, syntheticRequest).then((permit) => {
        order.push("root");
        return permit;
      });
      const first = capacity.acquire(signal, nestedRequester, syntheticRequest).then((permit) => {
        order.push("first descendant");
        return permit;
      });
      const secondChild = tree.spawn(parent.identity);
      const secondRequester = { processes: tree.processes, process: secondChild.identity.handle };
      const second = capacity.acquire(signal, secondRequester, syntheticRequest).then((permit) => {
        order.push("second descendant");
        return permit;
      });
      expect(capacity.active).toBe(capacity.limit);
      expect(order).toEqual([]);

      await release();
      const firstPermit = await first;
      expect(capacity.active).toBeLessThanOrEqual(capacity.limit);
      expect(order).toEqual(["first descendant"]);
      firstPermit.release();
      const secondPermit = await second;
      expect(capacity.active).toBeLessThanOrEqual(capacity.limit);
      expect(order).toEqual(["first descendant", "second descendant"]);
      secondPermit.release();
      const rootPermit = await root;
      expect(order).toEqual(["first descendant", "second descendant", "root"]);
      rootPermit.release();
      expect(capacity.active).toBe(0);
    } finally {
      await tree.close();
    }
  });

  it("removes an aborted descendant from the strict-cap queue without blocking its successor", async () => {
    const tree = processTree();
    const capacity = new ChildWorkerCapacity(1);
    const parent = tree.spawn();
    const requester = { processes: tree.processes, process: parent.identity.handle };
    const signal = new AbortController().signal;
    try {
      const release = await hold(capacity, parent);
      const controller = new AbortController();
      const cancelled = capacity.reserve(controller.signal, requester, syntheticRequest);
      const next = capacity.reserve(signal, requester, syntheticRequest);
      const reason = { cancelled: "nested request" };
      const rejected = expect(cancelled).rejects.toBe(reason);
      controller.abort(reason);
      await rejected;
      await release();
      const reservation = await next;
      await expect(reservation.run(signal, async () => 17, parent, syntheticRequest)).resolves.toBe(
        17,
      );
      expect(capacity.active).toBe(0);
    } finally {
      await tree.close();
    }
  });
});
