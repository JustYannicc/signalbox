import { afterEach, expect, it, vi } from "vite-plus/test";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import {
  KernelBashPortBusyError,
  KernelBashPortCompletedError,
} from "../../kernel/KernelBashPortError.ts";
import { ChildBashExecutionGroup } from "../ChildBashExecutionGroup.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createChildWorkerRunner } from "../ChildWorkerProgram.ts";
import { commandGatewayFixture, exited } from "../commandGatewayTesting.ts";
import { bashCredentials, childBashFixture } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
afterEach(() => vi.useRealTimers());

function emptySource(): KernelBashForkSource {
  return {
    async state() {
      return {
        version: 1,
        memoryBytes: 0,
        stackPointer: 0,
        continuation: { resume: 0 },
        captures: {
          stack: { low: 0, high: 0, log: 0 },
          base: 0,
          size: 0,
          names: [],
          stackNames: [],
          captures: [],
          top: 0,
          liveBytes: 0,
          nextId: 1,
          nextGeneration: 1,
        },
      };
    },
    read: async () => new Uint8Array(),
    restored: async () => {},
  };
}

it("drains a command whose Bash port completes before its deferred exec starts", async () => {
  vi.useFakeTimers();
  const replacement = vi.fn();
  const fixture = commandGatewayFixture({
    async run(input, invocation) {
      if (input.command.executable !== "/bin/bash") replacement();
      const host = await invocation.host<KernelBashPort>();
      const started = await host.startOperation!({
        kind: "exec",
        request: { path: "/bin/cat", args: ["cat"], env: {} },
      });
      if (started.kind !== "pending") throw new Error("Exec did not defer");
      await host.park!(emptySource(), started.id);
      await host.complete({ kind: "exit", status: exited(23) });
      invocation.acknowledge();
      return exited(23);
    },
  });
  let child: Awaited<ReturnType<typeof fixture.gateway.exec>> | undefined;
  try {
    child = await fixture.gateway.exec(
      { executable: "/bin/bash", argv: ["bash", "-c", "exec cat"], cwd: "/workspace", env: {} },
      fixture.controller.signal,
      undefined,
    );
    await expect(child.exited).resolves.toEqual(exited(23));
    await vi.runOnlyPendingTimersAsync();
    await expect(fixture.gateway.drain()).resolves.toBeUndefined();
    expect(replacement).not.toHaveBeenCalled();
    expect(fixture.capacity.active).toBe(0);
    expect(fixture.capacity.waiting).toBe(0);
    expect(fixture.machineSpawn).not.toHaveBeenCalled();
  } finally {
    await vi.runOnlyPendingTimersAsync();
    await child?.dispose();
    await fixture.close().catch(() => {});
  }
});

it.each(["completed", "closed"] as const)(
  "joins an obsolete deferred exec after its owner is %s without losing its exit",
  async (state) => {
    vi.useFakeTimers();
    const exec = vi.fn(async () => exited(7));
    const fixture = groupFixture(exec, async (owner) => {
      if (state === "closed") await owner.close();
      else await owner.port.complete({ kind: "exit", status: exited(23) });
    });
    const outcome = fixture.group
      .run(fixture.files.context, fixture.files.owner, undefined, true)
      .catch((error: unknown) => error);
    try {
      await fixture.parked;
      await vi.runOnlyPendingTimersAsync();
      expect(await outcome).toMatchObject({
        name: state === "closed" ? "KernelBashPortClosedError" : "KernelBashPortCompletedError",
        operation: "exec",
      });
      await expect(fixture.files.owner.exited).resolves.toEqual(
        state === "closed" ? { exitCode: 0, signal: 9, coreDumped: false } : exited(23),
      );
      await expect(fixture.group.finish(fixture.files.owner.close)).resolves.toBeUndefined();
      await expect(fixture.runner.drain()).resolves.toBeUndefined();
      expect(exec).not.toHaveBeenCalled();
      expect(fixture.capacity.active).toBe(0);
    } finally {
      await fixture.files.close();
    }
  },
);

const identity = { pid: 123, commandId: "command-123", operation: "exec" };
it.each([
  () => new Error("Replacement cleanup failed"),
  () =>
    Object.assign(new Error("Spoofed terminal port error"), {
      name: "KernelBashPortCompletedError",
      operation: "exec",
    }),
  () => new KernelBashPortBusyError(identity, "exec"),
  () => new KernelBashPortCompletedError({ ...identity, operation: "wait" }),
  () =>
    new AggregateError([
      new KernelBashPortCompletedError(identity),
      new Error("Unknown cleanup failure mixed with a stale exec"),
    ]),
])("keeps a genuine or mixed replacement failure fatal to drain (%#)", async (makeFailure) => {
  vi.useFakeTimers();
  const failure = makeFailure();
  const fixture = groupFixture(async () => {
    throw failure;
  });
  const outcome = fixture.group
    .run(fixture.files.context, fixture.files.owner, undefined, true)
    .catch((error: unknown) => error);
  try {
    await fixture.parked;
    await vi.runOnlyPendingTimersAsync();
    expect(await outcome).toBe(failure);
    await expect(fixture.group.finish(fixture.files.owner.close)).rejects.toBe(failure);
    await expect(fixture.runner.drain()).resolves.toBeUndefined();
    expect(fixture.capacity.active).toBe(0);
  } finally {
    await fixture.files.close();
  }
});

function groupFixture(
  exec: NonNullable<NonNullable<Parameters<typeof childBashFixture>[0]>["exec"]>,
  beforeReturn?: (owner: ReturnType<typeof childBashFixture>["owner"]) => Promise<void>,
) {
  const files = childBashFixture({ exec });
  const parked = Promise.withResolvers<void>();
  const capacity = new ChildWorkerCapacity(1, {
    owner: "test/bash-port-cleanup",
    RESIDENT_BYTE_LIMIT: String(104 * 1024 * 1024),
  });
  const runner = createChildWorkerRunner<KernelBashPort>({
    executable: "/bin/bash",
    code: { mainModule: "main.js", modules: { "main.js": "export default {}" } },
    capacity,
    dispatch: {
      async run(_input, host) {
        const started = await host.startOperation!({
          kind: "exec",
          request: { path: "/bin/tool", args: ["tool"], env: {} },
        });
        if (started.kind !== "pending") throw new Error("Exec did not defer");
        await host.park!(emptySource(), started.id);
        await beforeReturn?.(files.owner);
        parked.resolve();
        return exited();
      },
    },
  });
  return {
    files,
    parked: parked.promise,
    capacity,
    runner,
    group: new ChildBashExecutionGroup(runner, runner, bashCredentials),
  };
}
