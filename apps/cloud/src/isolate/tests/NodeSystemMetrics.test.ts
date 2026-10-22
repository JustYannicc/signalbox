import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SYSTEM_IDENTITY,
  systemIdentityForThread,
} from "@t3tools/contracts/systemIdentity";

import { createNodeSystemMetrics } from "../NodeSystemMetrics.ts";

const gib = 1024 ** 3;

describe("modeled Node system metrics", () => {
  it("keeps memory, vCPU, CPU and network values inside the resolved machine identity", () => {
    let nowNs = 10_000_000_000n;
    const identity = systemIdentityForThread("metrics-thread", {
      ...DEFAULT_SYSTEM_IDENTITY,
      resources: { memoryBytes: 8 * gib, vcpus: 6, profile: "steady" },
    });
    const metrics = createNodeSystemMetrics(identity, {
      readMonotonicTimeNs: () => nowNs,
    });
    const memory = metrics.memoryUsage();
    const interfaces = metrics.networkInterfaces();
    const cpuEntries = metrics.cpus();

    expect(metrics.totalMemoryBytes).toBe(8 * gib);
    expect(metrics.freeMemoryBytes).toBe(7 * gib);
    expect(metrics.availableParallelism).toBe(6);
    expect(metrics.cpus()).toHaveLength(6);
    expect(metrics.loadavg()).toEqual([0.08, 0.06, 0.04]);
    expect(metrics.uptime()).toBe(0);
    expect(memory).toEqual({
      rss: gib,
      heapTotal: Math.floor(gib / 3),
      heapUsed: Math.floor(Math.floor(gib / 3) / 2),
      external: gib / 16,
      arrayBuffers: gib / 64,
    });
    expect(memory.rss).toBeLessThan(metrics.totalMemoryBytes);
    expect(memory.heapUsed).toBeLessThanOrEqual(memory.heapTotal);
    expect(memory.heapTotal).toBeLessThanOrEqual(memory.rss);
    expect(memory.external).toBeLessThanOrEqual(memory.rss);
    expect(memory.arrayBuffers).toBeLessThanOrEqual(memory.external);
    expect(Object.keys(interfaces)).toEqual(["lo", "eth0"]);
    expect(interfaces.lo?.map(({ family }) => family)).toEqual(["IPv4", "IPv6"]);
    expect(interfaces.eth0?.[0]).toMatchObject({
      family: "IPv4",
      internal: false,
      netmask: "255.255.0.0",
    });
    expect(interfaces.eth0?.[0]?.address).toMatch(/^10\.192\.\d+\.\d+$/);
    expect(interfaces.eth0?.[0]?.mac).toMatch(/^02:/);
    expect(interfaces.eth0?.[0]?.address).not.toContain("metrics-thread");
    expect(cpuEntries[0]?.model).toBe("x86_64 virtual CPU");

    cpuEntries[0]!.times.user = 99;
    interfaces.eth0![0]!.address = "host-address";
    expect(metrics.cpus()[0]?.times.user).toBe(0);
    expect(metrics.networkInterfaces().eth0?.[0]?.address).not.toBe("host-address");

    nowNs += 1_000_000_000n;
    expect(metrics.uptime()).toBe(1);
    expect(metrics.cpuSnapshot()).toEqual({ userNs: 20_000_000n, systemNs: 5_000_000n });
    expect(metrics.loadavg()).toEqual([0.08, 0.06, 0.04]);
  });

  it("keeps real CPU microseconds when accounting is supplied", () => {
    const identity = systemIdentityForThread("accounted-thread");
    const metrics = createNodeSystemMetrics(identity, {
      readCpuAccounting: () => ({ userNs: 123_456_789n, systemNs: 3_456_789n }),
    });

    expect(metrics.cpuSnapshot()).toEqual({ userNs: 123_456_789n, systemNs: 3_456_789n });
    expect(metrics.resourceUsage()).toMatchObject({
      userCPUTime: 123_456,
      systemCPUTime: 3_456,
      maxRSS: Math.floor(metrics.memoryUsage().rss / 1024),
    });
  });
});
