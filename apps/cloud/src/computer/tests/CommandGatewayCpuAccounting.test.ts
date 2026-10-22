import { describe, expect, it, vi } from "vite-plus/test";
import { KernelCpuAccounting } from "../../kernel/KernelCpuAccounting.ts";
import { commandGatewayFixture } from "../commandGatewayTesting.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

describe("command gateway CPU accounting", () => {
  it("meters both command hosts through one execution over the supplied accounting", async () => {
    const accounting = new KernelCpuAccounting(() => 0n);
    const fixture = commandGatewayFixture({ cpuAccounting: accounting });
    try {
      const { host, isolateHost } = fixture.gateway;
      expect(host.cpuExecution).toBeDefined();
      expect(isolateHost.cpuExecution).toBe(host.cpuExecution);
      expect(() =>
        accounting.createExecutionMeter(
          () => undefined,
          () => false,
        ),
      ).toThrow("CPU accounting already has an execution meter");
    } finally {
      await fixture.close();
    }
  });
});
