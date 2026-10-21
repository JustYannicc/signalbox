import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBusyboxPort } from "../../kernel/KernelBusyboxPort.ts";
import type { KernelCommandChild } from "../../kernel/KernelCommandForwarder.ts";
import { commandGatewayFixture, readAll, writeStdio } from "./CommandGatewayAdmissionFixture.ts";
import { exited } from "./ChildBusyboxFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("queued command gateway admission", () => {
  it("completes limit plus five root commands in order with exact results under the soft limit", async () => {
    const full = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const started: number[] = [];
    const children: KernelCommandChild[] = [];
    let maximum = 0;
    const fixture = commandGatewayFixture({
      capacityLimit: 10,
      async run(input, invocation) {
        try {
          const index = Number(input.command.argv[1]);
          started.push(index);
          maximum = Math.max(maximum, fixture.capacity.active);
          if (started.length === fixture.capacity.limit) full.resolve();
          await release.promise;
          const host = await invocation.host<KernelBusyboxPort>();
          await writeStdio(host, 1, Uint8Array.of(index, 255));
          return exited(index);
        } finally {
          invocation.acknowledge();
        }
      },
    });
    const commands = Array.from({ length: fixture.capacity.limit + 5 }, async (_, index) => {
      const child = await fixture.gateway.exec(
        { executable: "/bin/cat", argv: ["cat", String(index)], cwd: "/workspace", env: {} },
        fixture.controller.signal,
      );
      children.push(child);
      const [stdout, stderr, exit] = await Promise.all([
        readAll(child.stdout),
        readAll(child.stderr),
        child.exited,
      ]);
      return { stdout, stderr, exit };
    });
    try {
      await full.promise;
      expect(started).toEqual(Array.from({ length: fixture.capacity.limit }, (_, index) => index));
      release.resolve();
      expect(await Promise.all(commands)).toEqual(
        Array.from({ length: fixture.capacity.limit + 5 }, (_, index) => ({
          stdout: Uint8Array.of(index, 255),
          stderr: new Uint8Array(),
          exit: exited(index),
        })),
      );
      expect(started).toEqual(
        Array.from({ length: fixture.capacity.limit + 5 }, (_, index) => index),
      );
      expect(maximum).toBe(fixture.capacity.limit);
      await fixture.gateway.drain();
      expect(fixture.capacity.active).toBe(0);
    } finally {
      release.resolve();
      await Promise.allSettled(commands);
      await Promise.all(children.map((child) => child.dispose()));
      await fixture.close();
    }
  });
});
