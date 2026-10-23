import { expect, it, vi } from "vite-plus/test";
import { commandGatewayFixture, exited, writeStdio } from "../../computer/commandGatewayTesting.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { createHookService } from "../HookService.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
const syntheticRequest = Object.freeze({ codeId: "test-holder", residentBytes: 0 });

it("runs command hooks after the ten invoking shells acknowledge stop", async () => {
  const attempted = Promise.withResolvers<void>();
  const allStopAcks = Promise.withResolvers<void>();
  const allDispatches = Promise.withResolvers<void>();
  const dispatch = Promise.withResolvers<void>();
  let attempts = 0;
  let stopAcks = 0;
  let dispatches = 0;
  const fixture = commandGatewayFixture({
    capacityLimit: 10,
    async run(_input, invocation) {
      if (++dispatches === 10) allDispatches.resolve();
      try {
        await dispatch.promise;
        const host = await invocation.host<KernelBusyboxPort>();
        await writeStdio(host, 1, new TextEncoder().encode("hook ran"));
        return exited();
      } finally {
        invocation.acknowledge();
      }
    },
  });
  const reserve = fixture.capacity.reserve.bind(fixture.capacity);
  vi.spyOn(fixture.capacity, "reserve").mockImplementation((...args) => {
    const pending = reserve(...args);
    if (++attempts === 10) attempted.resolve();
    return pending;
  });
  const hooks = createHookService({
    registrations: new Map([
      [
        "command",
        {
          harness: "claude-code",
          event: "pre-tool-use",
          sessionId: "session",
          kind: "command",
          command: { executable: "/bin/pwd", argv: ["pwd"] },
        },
      ],
    ]),
    commands: fixture.gateway.isolate,
    generated: {
      invoke: async () => {
        throw new Error("Wrong hook route");
      },
    },
    capacity: fixture.capacity,
  });
  const shellExit = Promise.withResolvers<ReturnType<typeof exited>>();
  const parents = Array.from({ length: 10 }, () => {
    const result = fixture.context.processes.spawn(
      undefined,
      () => ({
        completion: shellExit.promise,
        signal: () => ({ status: "ok", value: undefined }),
      }),
      () => {},
    );
    if (result.status !== "ok") throw new Error("Shell did not start");
    return result.value.handle;
  });
  const running = Promise.all(
    parents.map((process) =>
      fixture.capacity.run(
        fixture.controller.signal,
        async (execution) => {
          const hook = hooks.invoke(
            "command",
            {},
            {
              signal: fixture.controller.signal,
              cwd: "/workspace",
              env: {},
              requester: { processes: fixture.context.processes, process },
            },
          );
          void hook.catch(() => undefined);
          await attempted.promise;
          // In this fixture, every hook request is queued before its shell stop is acknowledged.
          if (++stopAcks === 10) allStopAcks.resolve();
          await allStopAcks.promise;
          await execution.handoff();
          return hook;
        },
        { processes: fixture.context.processes, process },
        syntheticRequest,
      ),
    ),
  );
  void running.catch(() => undefined);
  try {
    await attempted.promise;
    await allDispatches.promise;
    expect(fixture.capacity.active).toBe(10);
    dispatch.resolve();
    const results = await running;
    expect(results.map((result) => new TextDecoder().decode(result.stdout))).toEqual(
      Array(10).fill("hook ran"),
    );
    expect(results.every((result) => result.exit.exitCode === 0)).toBe(true);
    expect(fixture.capacity.active).toBe(0);
    expect(fixture.machineSpawn).not.toHaveBeenCalled();
  } finally {
    fixture.controller.abort();
    dispatch.resolve();
    await running.catch(() => undefined);
    shellExit.resolve(exited());
    await fixture.close();
  }
});
