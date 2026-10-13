// @effect-diagnostics nodeBuiltinImport:off - statfs has no Effect FileSystem counterpart.
import * as NodeFSP from "node:fs/promises";

import type { MachineUsage } from "@signalbox/runner-protocol/RunnerProtocol";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

/**
 * What the machine used since a Runner session began, measured from inside
 * the Runner's container on a thread's VM: its cgroup's CPU time and memory,
 * the disk holding its home, and the host network's sent bytes (the container
 * shares the host's network). Anything the machine cannot read, such as every
 * one of these files on a developer's Mac, is null.
 */

const CPU_STAT = "/sys/fs/cgroup/cpu.stat";
const MEMORY_CURRENT = "/sys/fs/cgroup/memory.current";
const NET_DEV = "/proc/net/dev";
const MEMORY_SAMPLE_INTERVAL = "5 seconds";

/** Interfaces whose traffic never leaves the machine. */
const LOCAL_INTERFACE = /^(lo|docker.*|veth.*|br-.*)$/;

const nonNegative = (value: number) => (Number.isFinite(value) && value >= 0 ? value : null);

/** CPU seconds from cgroup v2 `cpu.stat`'s `usage_usec` line. */
export const parseCpuSeconds = (text: string): number | null => {
  const usec = /^usage_usec\s+(\d+)\s*$/m.exec(text)?.[1];
  return usec === undefined ? null : Number(usec) / 1_000_000;
};

/** Bytes from cgroup v2 `memory.current`. */
export const parseMemoryBytes = (text: string): number | null => {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
};

/** Bytes sent over every outward interface in `/proc/net/dev`, null when it lists none. */
export const parseEgressBytes = (text: string): number | null => {
  let total: number | null = null;
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim();
    // Receive has 8 columns before transmit's bytes.
    const transmitted = Number(
      line
        .slice(separator + 1)
        .trim()
        .split(/\s+/)[8],
    );
    if (name === "" || !Number.isFinite(transmitted)) continue;
    total = (total ?? 0) + (LOCAL_INTERFACE.test(name) ? 0 : transmitted);
  }
  return total;
};

/**
 * Used bytes of a filesystem from its `statfs`. Blocks count in the fragment
 * size; `bsize` is only the preferred I/O size, 1 MiB on some mounts.
 */
export const diskUsedBytes = (stats: {
  readonly blocks: number;
  readonly bfree: number;
  readonly bsize: number;
  readonly frsize?: number;
}) => nonNegative((stats.blocks - stats.bfree) * (stats.frsize ?? stats.bsize));

/** The session's memory samples: their peak and running mean. */
export interface MemorySamples {
  readonly count: number;
  readonly total: number;
  readonly peak: number | null;
}

export const NO_MEMORY_SAMPLES: MemorySamples = { count: 0, total: 0, peak: null };

export const addMemorySample = (samples: MemorySamples, bytes: number): MemorySamples => ({
  count: samples.count + 1,
  total: samples.total + bytes,
  peak: samples.peak === null ? bytes : Math.max(samples.peak, bytes),
});

/** Raw counters as read, before the session's baseline is taken off. */
export interface UsageReading {
  readonly cpuSeconds: number | null;
  readonly memoryBytes: number | null;
  readonly diskUsedBytes: number | null;
  readonly egressBytes: number | null;
}

const since = (current: number | null, baseline: number | null) =>
  current === null || baseline === null ? null : Math.max(0, current - baseline);

/** The usage a session reports: CPU and egress since its baseline, memory over its samples. */
export const machineUsage = (
  baseline: UsageReading,
  current: UsageReading,
  memory: MemorySamples,
): MachineUsage => ({
  cpuSeconds: since(current.cpuSeconds, baseline.cpuSeconds),
  memoryBytes: current.memoryBytes,
  memoryPeakBytes:
    memory.peak === null || current.memoryBytes === null
      ? (memory.peak ?? current.memoryBytes)
      : Math.max(memory.peak, current.memoryBytes),
  memoryAverageBytes: memory.count === 0 ? null : memory.total / memory.count,
  diskUsedBytes: current.diskUsedBytes,
  egressBytes: since(current.egressBytes, baseline.egressBytes),
});

export const isUnmeasured = (usage: MachineUsage) =>
  Object.values(usage).every((value) => value === null);

const UNMEASURED: MachineUsage = {
  cpuSeconds: null,
  memoryBytes: null,
  memoryPeakBytes: null,
  memoryAverageBytes: null,
  diskUsedBytes: null,
  egressBytes: null,
};

/**
 * Starts measuring a Runner session whose machine state lives under `home`.
 * The baseline is taken now and memory is sampled until the scope closes.
 * `sample` reads the usage so far. Outside a cgroup v2 container, such as on
 * a developer's Mac, it measures nothing, the disk included.
 */
export const makeRunnerUsage = Effect.fn("makeRunnerUsage")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const read = (path: string, parse: (text: string) => number | null) =>
    fs.readFileString(path).pipe(
      Effect.map(parse),
      Effect.orElseSucceed(() => null),
    );
  const readMemory = read(MEMORY_CURRENT, parseMemoryBytes);
  const reading = Effect.gen(function* () {
    const [cpuSeconds, memoryBytes, egressBytes, disk] = yield* Effect.all([
      read(CPU_STAT, parseCpuSeconds),
      readMemory,
      read(NET_DEV, parseEgressBytes),
      Effect.tryPromise(() => NodeFSP.statfs(home)).pipe(
        Effect.map(diskUsedBytes),
        Effect.orElseSucceed(() => null),
      ),
    ]);
    return { cpuSeconds, memoryBytes, egressBytes, diskUsedBytes: disk } satisfies UsageReading;
  });

  const baseline = yield* reading;
  if (baseline.cpuSeconds === null && baseline.memoryBytes === null) {
    return { sample: Effect.succeed(UNMEASURED) };
  }
  let memory = NO_MEMORY_SAMPLES;
  // Nothing to sample where the cgroup has no memory file.
  if (baseline.memoryBytes !== null) {
    yield* Effect.forever(
      readMemory.pipe(
        Effect.tap((bytes) =>
          Effect.sync(() => {
            if (bytes !== null) memory = addMemorySample(memory, bytes);
          }),
        ),
        Effect.andThen(Effect.sleep(MEMORY_SAMPLE_INTERVAL)),
      ),
    ).pipe(Effect.forkScoped);
  }

  return { sample: Effect.map(reading, (current) => machineUsage(baseline, current, memory)) };
});
