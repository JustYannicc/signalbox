import { expect, it, vi } from "vite-plus/test";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { WakeToken } from "../../kernel/KernelWakeRegistry.ts";
import { childBashFixture, exited, waitForChildExit } from "./ChildBashFixture.ts";

async function fork(port: KernelBashPort) {
  const child = await port.fork();
  if (child.kind !== "fork") throw new Error(`Fork failed with errno ${child.errno}`);
  return child;
}

it.each(["before wake consumption", "after wake delivery"] as const)(
  "preserves a batch of child exits while the parent is paused %s",
  async (pauseAt) => {
    const fixture = childBashFixture();
    const entered = Promise.withResolvers<WakeToken>();
    const delivered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    try {
      const first = await fork(fixture.owner.port);
      await first.port.complete({ kind: "exit", status: exited() });
      const firstProcess = fixture.processes.lookupPid(first.pid);
      if (firstProcess.status !== "ok") throw new Error("First child was not admitted");
      await waitForChildExit(fixture, firstProcess.value.handle);
      expect(await fixture.owner.port.wait(first.pid, 0)).toEqual({
        kind: "wait",
        pid: first.pid,
        status: exited(),
      });

      const children = [];
      for (let index = 0; index < 159; index++) children.push(await fork(fixture.owner.port));
      const sibling = await fork(fixture.owner.port);
      const wait = fixture.wakes.wait.bind(fixture.wakes);
      let intercepted = false;
      vi.spyOn(fixture.wakes, "wait").mockImplementation(async (token, signal) => {
        if (intercepted) return wait(token, signal);
        intercepted = true;
        entered.resolve(token);
        if (pauseAt === "before wake consumption") {
          await resume.promise;
          return wait(token, signal);
        }
        const result = await wait(token, signal);
        delivered.resolve();
        await resume.promise;
        return result;
      });

      let parentResumed = false;
      const waiting = fixture.owner.port.wait(-1, 0).then((result) => {
        parentResumed = true;
        return result;
      });
      const token = await entered.promise;
      await Promise.all(
        children.map(async (child, index) => {
          const process = fixture.processes.lookupPid(child.pid);
          if (process.status !== "ok") throw new Error("Child was not admitted");
          await child.port.complete({ kind: "exit", status: exited(index + 1) });
          await waitForChildExit(fixture, process.value.handle);
        }),
      );
      if (pauseAt === "after wake delivery") await delivered.promise;

      // Exited children must remain waitable while their parent is descheduled.
      expect(fixture.processes.lookupPid(first.pid).status).toBe("error");
      for (const child of children)
        expect(fixture.processes.lookupPid(child.pid)).toMatchObject({
          status: "ok",
          value: { status: "exited" },
        });
      expect(fixture.processes.lookupPid(sibling.pid)).toMatchObject({
        status: "ok",
        value: { status: "running" },
      });
      expect(parentResumed).toBe(false);
      expect(fixture.wakes.has(token)).toBe(pauseAt === "before wake consumption");

      // Another process can reap these entries before the parent's wait retries.
      const grandchild = await fork(sibling.port);
      for (const child of children)
        expect(fixture.processes.lookupPid(child.pid).status).toBe("error");
      expect(parentResumed).toBe(false);
      resume.resolve();
      expect(await waiting).toEqual({ kind: "wait", pid: children[0]!.pid, status: exited(1) });
      for (let index = 1; index < children.length; index++)
        expect(await fixture.owner.port.wait(-1, 0)).toEqual({
          kind: "wait",
          pid: children[index]!.pid,
          status: exited(index + 1),
        });

      await grandchild.port.complete({ kind: "exit", status: exited() });
      expect(await sibling.port.wait(grandchild.pid, 0)).toEqual({
        kind: "wait",
        pid: grandchild.pid,
        status: exited(),
      });
      await sibling.port.complete({ kind: "exit", status: exited() });
      expect(await fixture.owner.port.wait(sibling.pid, 0)).toEqual({
        kind: "wait",
        pid: sibling.pid,
        status: exited(),
      });
      expect(await fixture.owner.port.wait(-1, 1)).toEqual({ kind: "error", errno: 12 });
      expect(fixture.wakes.size).toBe(0);
    } finally {
      resume.resolve();
      try {
        await fixture.close();
      } finally {
        vi.restoreAllMocks();
      }
    }
  },
);
