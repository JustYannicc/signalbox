import { describe, expect, it } from "@effect/vitest";

import {
  addMemorySample,
  diskUsedBytes,
  isUnmeasured,
  machineUsage,
  NO_MEMORY_SAMPLES,
  parseCpuSeconds,
  parseEgressBytes,
  parseMemoryBytes,
} from "./RunnerUsage.ts";

const CPU_STAT = `usage_usec 12500000
user_usec 9000000
system_usec 3500000
nr_periods 0
nr_throttled 0
throttled_usec 0
`;

const NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 9000000   1000    0    0    0     0          0         0 9000000   1000    0    0    0     0       0          0
  eth0: 5000000   4000    0    0    0     0          0         0  700000    900    0    0    0     0       0          0
  ens5:123 4 0 0 0 0 0 0 300000 5 0 0 0 0 0 0
docker0:    1000     10    0    0    0     0          0         0   80000     70    0    0    0     0       0          0
veth1a2b:   1000     10    0    0    0     0          0         0   80000     70    0    0    0     0       0          0
br-5f0e:    1000     10    0    0    0     0          0         0   80000     70    0    0    0     0       0          0
`;

describe("RunnerUsage", () => {
  it("reads CPU seconds from cpu.stat", () => {
    expect(parseCpuSeconds(CPU_STAT)).toBe(12.5);
    expect(parseCpuSeconds("user_usec 5\n")).toBeNull();
  });

  it("reads memory.current", () => {
    expect(parseMemoryBytes("104857600\n")).toBe(104_857_600);
    expect(parseMemoryBytes("max\n")).toBeNull();
  });

  it("sums sent bytes over outward interfaces only", () => {
    expect(parseEgressBytes(NET_DEV)).toBe(1_000_000);
    expect(parseEgressBytes("")).toBeNull();
  });

  it("measures used disk from statfs", () => {
    expect(diskUsedBytes({ blocks: 1000, bfree: 250, bsize: 4096 })).toBe(750 * 4096);
    // Docker Desktop's bind mounts report a 1 MiB bsize over 4 KiB blocks.
    expect(diskUsedBytes({ blocks: 1000, bfree: 250, bsize: 1_048_576, frsize: 4096 })).toBe(
      750 * 4096,
    );
  });

  it("reports CPU and egress since the baseline and memory over the samples", () => {
    const memory = [300, 100, 200].reduce(addMemorySample, NO_MEMORY_SAMPLES);
    const usage = machineUsage(
      { cpuSeconds: 10, memoryBytes: 100, diskUsedBytes: 5, egressBytes: 1_000 },
      { cpuSeconds: 12.5, memoryBytes: 150, diskUsedBytes: 7, egressBytes: 4_000 },
      memory,
    );
    expect(usage).toEqual({
      cpuSeconds: 2.5,
      memoryBytes: 150,
      memoryPeakBytes: 300,
      memoryAverageBytes: 200,
      diskUsedBytes: 7,
      egressBytes: 3_000,
    });
  });

  it("leaves everything null where nothing can be read", () => {
    const nothing = { cpuSeconds: null, memoryBytes: null, diskUsedBytes: null, egressBytes: null };
    const usage = machineUsage(nothing, nothing, NO_MEMORY_SAMPLES);
    expect(isUnmeasured(usage)).toBe(true);
    expect(isUnmeasured({ ...usage, diskUsedBytes: 0 })).toBe(false);
  });
});
