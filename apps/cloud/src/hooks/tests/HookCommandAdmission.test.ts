import { expect, it, vi } from "vite-plus/test";
import {
  commandGatewayFixture,
  writeStdio,
} from "../../computer/tests/CommandGatewayAdmissionFixture.ts";
import { exited } from "../../computer/tests/ChildBusyboxFixture.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { createHookService } from "../HookService.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

it("runs command hooks while all ten invoking shells hold the shared pool", async () => {
  const attempted = Promise.withResolvers<void>();
  const dispatch = Promise.withResolvers<void>();
  let attempts = 0;
  const fixture = commandGatewayFixture({
    capacityLimit: 10,
    async run(_input, invocation) {
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
        () =>
          hooks.invoke(
            "command",
            {},
            {
              signal: fixture.controller.signal,
              cwd: "/workspace",
              env: {},
              requester: { processes: fixture.context.processes, process },
            },
          ),
        { processes: fixture.context.processes, process },
      ),
    ),
  );
  void running.catch(() => undefined);
  try {
    await attempted.promise;
    expect(fixture.capacity.active).toBe(20);
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
