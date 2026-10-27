import { expect, it, vi } from "vite-plus/test";
import { commandGatewayFixture, exited, writeStdio } from "../../computer/commandGatewayTesting.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { createNodeComputerChildProcess } from "../NodeComputerProcess.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));
const syntheticRequest = Object.freeze({ codeId: "test-holder", residentBytes: 0 });

it("admits a nested Node shim before queued roots in the same command pool", async () => {
  const attempted = Promise.withResolvers<void>();
  const dispatchStarted = Promise.withResolvers<void>();
  const dispatch = Promise.withResolvers<void>();
  const fixture = commandGatewayFixture({
    capacityLimit: 1,
    async run(_input, invocation) {
      dispatchStarted.resolve();
      try {
        await dispatch.promise;
        await writeStdio(
          await invocation.host<KernelBusyboxPort>(),
          1,
          new TextEncoder().encode("nested shim"),
        );
        return exited(7);
      } finally {
        invocation.acknowledge();
      }
    },
  });
  const enqueue = fixture.capacity.enqueue.bind(fixture.capacity);
  vi.spyOn(fixture.capacity, "enqueue").mockImplementation((...args) => {
    const ticket = enqueue(...args);
    attempted.resolve();
    return ticket;
  });
  const queued = new AbortController();
  let root: Promise<void> | undefined;
  let rootAdmitted = false;
  const running = fixture.capacity.run(
    fixture.controller.signal,
    async (execution) => {
      root = fixture.capacity
        .acquire(queued.signal, undefined, syntheticRequest)
        .then(async (permit) => {
          rootAdmitted = true;
          await permit.release();
        });
      void root.catch(() => undefined);
      const shim = createNodeComputerChildProcess(
        fixture.gateway.host,
        {
          filesystem: fixture.filesystem,
          env: {},
          parent: fixture.context.identity.handle,
          signal: fixture.controller.signal,
        },
        fixture.gateway,
      );
      const child = shim.spawn("/bin/pwd");
      const done = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", () => resolve());
      });
      void done.catch(() => undefined);
      const output: string[] = [];
      child.stdout?.on("data", (chunk) => output.push(String(chunk)));
      child.stdin?.end();
      await attempted.promise;
      // The fake invoking shell ACKs stop after the shim has queued nested admission.
      const stopAck = Promise.withResolvers<void>();
      stopAck.resolve();
      await stopAck.promise;
      await execution.handoff();
      await dispatchStarted.promise;
      expect(fixture.capacity.active).toBe(1);
      expect(rootAdmitted).toBe(false);
      dispatch.resolve();
      await done;
      expect(child.exitCode).toBe(7);
      expect(output.join("")).toBe("nested shim");
      await root;
      expect(rootAdmitted).toBe(true);
    },
    { processes: fixture.context.processes, process: fixture.context.identity.handle },
    syntheticRequest,
  );
  try {
    await running;
    await root;
    expect(rootAdmitted).toBe(true);
    expect(fixture.capacity.active).toBe(0);
    expect(fixture.machineSpawn).not.toHaveBeenCalled();
  } finally {
    queued.abort();
    fixture.controller.abort();
    dispatch.resolve();
    await running.catch(() => undefined);
    await root?.catch(() => undefined);
    await fixture.close();
  }
});
