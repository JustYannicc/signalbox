import { afterEach, expect, it, vi } from "vite-plus/test";
import { createKernelBashOperations } from "../../kernel/KernelBashOperations.ts";
import { childBashFixture, exited } from "./ChildBashFixture.ts";

const request = { path: "/bin/tool", args: ["tool"], env: {} };

afterEach(() => vi.useRealTimers());

it.each(["completed", "closed"] as const)(
  "refuses a deferred exec after the process is %s with its command identity",
  async (state) => {
    vi.useFakeTimers();
    const exec = vi.fn(async () => exited(7));
    const fixture = childBashFixture({ exec });
    const operations = createKernelBashOperations(fixture.owner.port);
    try {
      const started = await operations.start({ kind: "exec", request });
      if (started.kind !== "pending") throw new Error("Exec did not defer");
      if (state === "closed") await fixture.owner.close();
      else await fixture.owner.port.complete({ kind: "exit", status: exited(23) });
      const outcome = operations.take(started.id).catch((error: unknown) => error);
      await vi.runOnlyPendingTimersAsync();
      expect(await outcome).toMatchObject({
        name: state === "closed" ? "KernelBashPortClosedError" : "KernelBashPortCompletedError",
        pid: fixture.context.identity.pid,
        commandId: fixture.context.identity.handle.id,
        operation: "exec",
      });
      expect(exec).not.toHaveBeenCalled();
      await expect(fixture.owner.exited).resolves.toEqual(
        state === "closed" ? { exitCode: 0, signal: 9, coreDumped: false } : exited(23),
      );
    } finally {
      await operations.close();
      await fixture.close();
    }
  },
);

it("refuses overlapping execs, keeps the first result, and permits a later serial call", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const exec = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return exited(7);
  });
  const fixture = childBashFixture({ exec });
  try {
    const first = fixture.owner.port.exec(request);
    await entered.promise;
    await expect(fixture.owner.port.exec(request)).rejects.toMatchObject({
      name: "KernelBashPortBusyError",
      pid: fixture.context.identity.pid,
      commandId: fixture.context.identity.handle.id,
      operation: "exec",
      activeOperation: "exec",
    });
    await expect(
      fixture.owner.port.complete({ kind: "exit", status: exited() }),
    ).rejects.toMatchObject({
      name: "KernelBashPortBusyError",
      operation: "complete",
      activeOperation: "exec",
    });
    release.resolve();
    await expect(first).resolves.toEqual({ kind: "exit", status: exited(7) });
    await expect(fixture.owner.port.exec(request)).resolves.toEqual({
      kind: "exit",
      status: exited(7),
    });
    expect(exec).toHaveBeenCalledTimes(2);
  } finally {
    release.resolve();
    await fixture.close();
  }
});

it("joins a valid deferred exec before closing", async () => {
  vi.useFakeTimers();
  const fixture = childBashFixture({ exec: async () => exited(7) });
  const operations = createKernelBashOperations(fixture.owner.port);
  try {
    const started = await operations.start({ kind: "exec", request });
    if (started.kind !== "pending") throw new Error("Exec did not defer");
    const outcome = operations.take(started.id);
    await vi.runOnlyPendingTimersAsync();
    await expect(outcome).resolves.toEqual({
      kind: "exec",
      value: { kind: "exit", status: exited(7) },
    });
    await fixture.owner.port.complete({ kind: "exit", status: exited(7) });
    await expect(fixture.owner.exited).resolves.toEqual(exited(7));
  } finally {
    await operations.close();
    await fixture.close();
  }
});
