import { describe, expect, it, vi } from "vite-plus/test";
import { commandGatewayFixture, exited, readAll } from "../commandGatewayTesting.ts";
import type { ChildWorkerInvocation } from "../ChildWorkerProgram.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("stable command program slots", () => {
  it("admits two instances of every stable program with distinct live loader IDs", async () => {
    const executables = ["/bin/cat", "/bin/echo", "/bin/rg", "/usr/bin/git"];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const invocations: ChildWorkerInvocation[] = [];
    const fixture = commandGatewayFixture({
      capacityLimit: 10,
      async run(input, invocation) {
        await invocation.host();
        invocations.push(input);
        if (invocations.length === executables.length * 2) entered.resolve();
        try {
          await release.promise;
          return exited();
        } finally {
          invocation.acknowledge();
        }
      },
    });
    const running = executables.flatMap((executable) =>
      Array.from({ length: 2 }, async () => {
        const child = await fixture.gateway.exec(
          { executable, argv: [executable], cwd: "/workspace", env: {} },
          fixture.controller.signal,
          undefined,
        );
        try {
          return await Promise.all([readAll(child.stdout), readAll(child.stderr), child.exited]);
        } finally {
          await child.dispose();
        }
      }),
    );
    try {
      await entered.promise;
      expect(fixture.capacity.active).toBe(8);
      expect(new Set(invocations.map((input) => input.loaderId)).size).toBe(8);
      for (const executable of executables) {
        const pair = invocations.filter((input) => input.command.executable === executable);
        expect(pair).toHaveLength(2);
        expect(pair[0]!.loaderId).toEqual(expect.any(String));
        expect(pair[1]!.loaderId).not.toBe(pair[0]!.loaderId);
      }
      release.resolve();
      for (const [stdout, stderr, status] of await Promise.all(running)) {
        expect(stdout.byteLength).toBe(0);
        expect(stderr.byteLength).toBe(0);
        expect(status).toEqual(exited());
      }
      await fixture.gateway.drain();
      expect(fixture.capacity.active).toBe(0);
      expect(fixture.machineSpawn).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled(running);
      await fixture.close();
    }
  });
});
