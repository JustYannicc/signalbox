import { expect, it, vi } from "vite-plus/test";
import { commandGatewayFixture, exited, writeStdio } from "../../computer/commandGatewayTesting.ts";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import { createNodeComputerChildProcess } from "../NodeComputerProcess.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

it("admits a nested Node shim before queued roots in the same command pool", async () => {
  const attempted = Promise.withResolvers<void>();
  const dispatch = Promise.withResolvers<void>();
  const fixture = commandGatewayFixture({
    capacityLimit: 1,
    async run(_input, invocation) {
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
  const reserve = fixture.capacity.reserve.bind(fixture.capacity);
  vi.spyOn(fixture.capacity, "reserve").mockImplementation((...args) => {
    const pending = reserve(...args);
    attempted.resolve();
    return pending;
  });
  const queued = new AbortController();
  let root: Promise<void> | undefined;
  let rootAdmitted = false;
  const running = fixture.capacity.run(
    fixture.controller.signal,
    async () => {
      root = fixture.capacity.acquire(queued.signal, undefined).then((permit) => {
        rootAdmitted = true;
        permit.release();
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
      expect(fixture.capacity.active).toBe(2);
      expect(rootAdmitted).toBe(false);
      dispatch.resolve();
      await done;
      expect(child.exitCode).toBe(7);
      expect(output.join("")).toBe("nested shim");
      expect(rootAdmitted).toBe(false);
    },
    { processes: fixture.context.processes, process: fixture.context.identity.handle },
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
