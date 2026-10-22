import type * as NodeOS from "node:os";
import type * as NodeProcess from "node:process";
import type { SystemIdentity } from "@t3tools/contracts/systemIdentity";

import type { KernelCpuSnapshot } from "../kernel/KernelCpuAccounting.ts";

type NodeCpuInfo = ReturnType<typeof NodeOS.cpus>[number];
type NodeMemoryUsage = ReturnType<typeof NodeProcess.memoryUsage>;
type NodeResourceUsage = ReturnType<typeof NodeProcess.resourceUsage>;
type NodeNetworkInterfaces = ReturnType<typeof NodeOS.networkInterfaces>;

const modeledCpuSpeedMHz = 2400;
const modeledLoadAverage = [0.08, 0.06, 0.04] as const;

function defaultMonotonicTimeNs(): bigint {
  const performanceObject = globalThis.performance;
  return performanceObject ? BigInt(Math.floor(performanceObject.now() * 1_000_000)) : 0n;
}

function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  }
  return hash >>> 0;
}

function ipv4For(identity: SystemIdentity): string {
  const hash = stableHash(identity.hostname);
  const thirdOctet = (hash >>> 8) & 0xff;
  const fourthOctet = (hash % 253) + 1;
  return "10.192." + thirdOctet + "." + fourthOctet;
}

function macFor(identity: SystemIdentity): string {
  const hash = stableHash(identity.hostname);
  const octets = [
    0x02,
    (hash >>> 24) & 0xff,
    (hash >>> 16) & 0xff,
    (hash >>> 8) & 0xff,
    hash & 0xff,
    ((hash >>> 24) ^ hash) & 0xff,
  ];
  return octets.map((octet) => octet.toString(16).padStart(2, "0")).join(":");
}

export interface NodeSystemMetricsOptions {
  readonly readMonotonicTimeNs?: () => bigint;
  readonly readCpuAccounting?: () => KernelCpuSnapshot | undefined;
}

/**
 * Returns modeled values from the shared per-thread identity. Host memory and CPU safety remain
 * the executor's responsibility, so these Node metrics never claim to report host telemetry.
 */
export function createNodeSystemMetrics(
  identity: SystemIdentity,
  options: NodeSystemMetricsOptions = {},
) {
  const readMonotonicTimeNs = options.readMonotonicTimeNs ?? defaultMonotonicTimeNs;
  const startedAtNs = readMonotonicTimeNs();
  const { memoryBytes, vcpus } = identity.resources;
  // The steady profile reserves one eighth of configured memory for this logical process.
  const modeledUsedBytes = Math.min(memoryBytes - 1, Math.max(1, Math.floor(memoryBytes / 8)));
  const modeledHeapTotalBytes = Math.min(
    modeledUsedBytes,
    Math.max(1, Math.floor(modeledUsedBytes / 3)),
  );
  const modeledHeapUsedBytes = Math.min(
    modeledHeapTotalBytes,
    Math.max(1, Math.floor(modeledHeapTotalBytes / 2)),
  );
  const modeledExternalBytes = Math.min(
    modeledUsedBytes,
    Math.max(1, Math.floor(modeledUsedBytes / 16)),
  );
  const modeledArrayBuffersBytes = Math.min(
    modeledExternalBytes,
    Math.max(1, Math.floor(modeledExternalBytes / 4)),
  );
  const address = ipv4For(identity);
  const mac = macFor(identity);

  const uptimeNs = () => {
    const elapsed = readMonotonicTimeNs() - startedAtNs;
    return elapsed > 0n ? elapsed : 0n;
  };

  const modeledCpuAccounting = (): KernelCpuSnapshot => {
    const elapsed = uptimeNs();
    // This explicit fallback reports a low, steady modeled CPU share when the kernel has no meter.
    return {
      userNs: elapsed / 50n,
      systemNs: elapsed / 200n,
    };
  };

  const cpuSnapshot = (): KernelCpuSnapshot => {
    const measured = options.readCpuAccounting?.();
    if (measured !== undefined) return { ...measured };
    return modeledCpuAccounting();
  };

  const memoryUsageValues = (): NodeMemoryUsage => ({
    rss: modeledUsedBytes,
    heapTotal: modeledHeapTotalBytes,
    heapUsed: modeledHeapUsedBytes,
    external: modeledExternalBytes,
    arrayBuffers: modeledArrayBuffersBytes,
  });

  const memoryUsage = Object.assign(() => memoryUsageValues(), {
    rss: () => modeledUsedBytes,
  });

  const cpuTimes = (): NodeCpuInfo["times"] => {
    const elapsedMs = Number(uptimeNs() / 1_000_000n);
    const user = Math.floor(elapsedMs * 0.02);
    const sys = Math.floor(elapsedMs * 0.005);
    return {
      user,
      nice: 0,
      sys,
      idle: Math.max(0, elapsedMs - user - sys),
      irq: 0,
    };
  };

  const cpus = (): NodeCpuInfo[] =>
    Array.from({ length: vcpus }, () => ({
      model: identity.machine + " virtual CPU",
      speed: modeledCpuSpeedMHz,
      times: cpuTimes(),
    }));

  const networkInterfaces = (): NodeNetworkInterfaces => ({
    lo: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
      {
        address: "::1",
        netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
        family: "IPv6",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "::1/128",
        scopeid: 0,
      },
    ],
    eth0: [
      {
        address,
        netmask: "255.255.0.0",
        family: "IPv4",
        mac,
        internal: false,
        cidr: address + "/16",
      },
    ],
  });

  const resourceUsage = (): NodeResourceUsage => {
    const memory = memoryUsageValues();
    const cpu = cpuSnapshot();
    return {
      userCPUTime: Number(cpu.userNs / 1_000n),
      systemCPUTime: Number(cpu.systemNs / 1_000n),
      maxRSS: Math.floor(memory.rss / 1024),
      sharedMemorySize: 0,
      unsharedDataSize: Math.floor(memory.heapTotal / 1024),
      unsharedStackSize: Math.min(1024, Math.floor(memory.rss / 8192)),
      minorPageFault: 0,
      majorPageFault: 0,
      swappedOut: 0,
      fsRead: 0,
      fsWrite: 0,
      ipcSent: 0,
      ipcReceived: 0,
      signalsCount: 0,
      voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 0,
    };
  };

  return Object.freeze({
    totalMemoryBytes: memoryBytes,
    freeMemoryBytes: memoryBytes - modeledUsedBytes,
    availableParallelism: vcpus,
    cpus,
    loadavg: () => [...modeledLoadAverage],
    uptime: () => Number(uptimeNs()) / 1_000_000_000,
    networkInterfaces,
    memoryUsage,
    resourceUsage,
    cpuSnapshot,
  });
}
