import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBashForkSource, KernelBashForkState } from "../../kernel/KernelBashFork.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { commandGatewayFixture, exited, readAll } from "../commandGatewayTesting.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

interface ParkablePort extends KernelBashPort {
  metadata(): Promise<{ readonly pid: number }>;
  forkSnapshot(): KernelBashForkSource | undefined;
  park(source: KernelBashForkSource): Promise<void>;
}

const state: KernelBashForkState = {
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

// Deployed on 2026-10-23: distinct invocation 11 is rejected in a DO; invocation 5 in a Worker.
const contexts = [
  { context: "DO I/O context", limit: 10 },
  { context: "plain Worker request", limit: 4 },
];

describe("physical Bash invocation admission", () => {
  it.each(contexts)(
    "keeps parked RPCs charged until they return in a $context",
    async ({ limit }) => {
      const captured = Promise.withResolvers<void>();
      const queued = Promise.withResolvers<void>();
      const returnRpc = Promise.withResolvers<void>();
      const parked = new Set<number>();
      const restored = new Set<number>();
      let captures = 0;
      let open = 0;
      let peak = 0;
      let starts = 0;
      const fixture = commandGatewayFixture({
        capacityLimit: limit,
        async run(_input, invocation) {
          open++;
          starts++;
          peak = Math.max(peak, open);
          try {
            const port = await invocation.host<ParkablePort>();
            const { pid } = await port.metadata();
            if (!parked.has(pid)) {
              parked.add(pid);
              await port.park({
                state: async () => state,
                read: async () => new Uint8Array(),
                async restored() {
                  captures++;
                },
              });
              if (captures === limit) captured.resolve();
              // Even a received stop ACK cannot free the permit while the RPC is still open.
              invocation.acknowledge();
              await returnRpc.promise;
            } else {
              const snapshot = await port.forkSnapshot();
              expect(snapshot).toBeDefined();
              await snapshot!.restored();
              restored.add(pid);
            }
            return exited();
          } finally {
            open--;
            invocation.acknowledge();
          }
        },
      });
      const stopPressure = fixture.capacity.onPressure((pressure) => {
        if (pressure.inFlight === limit && pressure.waiting > 0) queued.resolve();
      });
      const running: Promise<unknown>[] = [];
      const launch = async () => {
        const child = await fixture.gateway.exec(
          { executable: "/bin/bash", argv: ["bash"], cwd: "/workspace", env: {} },
          fixture.controller.signal,
          undefined,
        );
        try {
          const [stdout, stderr, result] = await Promise.all([
            readAll(child.stdout),
            readAll(child.stderr),
            child.exited,
          ]);
          expect(stdout.byteLength).toBe(0);
          expect(stderr.byteLength).toBe(0);
          expect(result).toEqual(exited());
        } finally {
          await child.dispose();
        }
      };
      try {
        for (let index = 0; index < limit; index++) running.push(launch());
        await captured.promise;
        running.push(launch());
        await queued.promise;
        expect(captures).toBe(limit);
        expect(open).toBe(limit);
        expect(starts).toBe(limit);
        expect(fixture.capacity.active).toBe(limit);
        expect(fixture.capacity.waiting).toBeGreaterThan(0);
        returnRpc.resolve();
        await Promise.all(running);
        await fixture.gateway.drain();
        expect(peak).toBeLessThanOrEqual(limit);
        expect(open).toBe(0);
        expect(starts).toBe(2 * (limit + 1));
        expect(restored.size).toBe(limit + 1);
        expect(fixture.capacity.active).toBe(0);
        expect(fixture.capacity.waiting).toBe(0);
      } finally {
        returnRpc.resolve();
        stopPressure();
        await Promise.allSettled(running);
        await fixture.close();
      }
    },
  );
});
