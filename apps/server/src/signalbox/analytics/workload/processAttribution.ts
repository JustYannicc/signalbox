/**
 * Charges the server's process tree to threads, so a turn reports the CPU and
 * memory of its own harness and commands.
 *
 * The server never learns which pid a provider spawned, so ownership is
 * inferred from evidence. Every harness is a direct child of the server (a
 * root). A root working in a thread's directory that started while that
 * thread's run was in flight belongs to the thread (Claude). A root working
 * elsewhere belongs to the one thread whose directory its commands run in
 * (Codex's app-server inherits the server's cwd). Ownership lasts for the
 * root's lifetime. A root nobody can claim alone, such as two threads
 * starting in one checkout at once, is never charged.
 *
 * @module processAttribution
 */
import type { ThreadId } from "@t3tools/contracts";

import { processIdentityKey } from "../../../resourceTelemetry/Model.ts";

export interface ProcessSample {
  readonly pid: number;
  readonly ppid: number;
  readonly startTimeMs: number;
  readonly name: string;
  /** Cumulative CPU time of the process itself. */
  readonly cpuTimeMs: number;
  readonly residentBytes: number;
}

export interface AttributionTurn {
  readonly threadId: ThreadId;
  /** Resolved working directory of the thread, if known. */
  readonly directory: string | undefined;
  /** When the run was requested; harnesses for it start after this. */
  readonly requestedAtMs: number;
}

export interface ThreadUsage {
  /** CPU time spent since the previous sample. */
  readonly cpuMs: number;
  readonly residentBytes: number;
}

export const processKey = (process: Pick<ProcessSample, "pid" | "startTimeMs">) =>
  processIdentityKey(process.pid, process.startTimeMs);

// Server children that are measurement or infrastructure, never a turn's work.
const IGNORED_ROOT_NAMES = new Set(["t3-resource-monitor", "lsof", "du", "find"]);
// Process start times and run timestamps come from different clocks.
const START_SLACK_MS = 1_000;

/** The most specific of `directories` that contains `cwd`. */
export function containingDirectory(
  cwd: string,
  directories: ReadonlyArray<string>,
): string | undefined {
  let best: string | undefined;
  for (const directory of directories) {
    const root = directory.replace(/[\\/]+$/, "");
    const inside = cwd === root || cwd.startsWith(`${root}/`) || cwd.startsWith(`${root}\\`);
    if (inside && (best === undefined || root.length > best.length)) best = directory;
  }
  return best;
}

/** The server child each process descends from, if any. */
function makeRootOf(serverPid: number, processes: ReadonlyArray<ProcessSample>) {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  return (process: ProcessSample): ProcessSample | undefined => {
    let current = process;
    for (let depth = 0; depth < 64; depth++) {
      if (current.pid === serverPid) return undefined;
      if (current.ppid === serverPid) return current;
      const parent = byPid.get(current.ppid);
      if (parent === undefined) return undefined;
      current = parent;
    }
    return undefined;
  };
}

export function makeProcessAttribution(serverPid: number) {
  const lastCpuMs = new Map<string, number>();
  const owners = new Map<string, ThreadId>();
  let previousSampleAtMs: number | undefined;

  /**
   * Charges one snapshot of the server's process tree to `turns`, the
   * threads with a run in flight. `cwdOf` answers by `processKey`.
   */
  const sample = (input: {
    readonly sampledAtMs: number;
    readonly processes: ReadonlyArray<ProcessSample>;
    readonly turns: ReadonlyArray<AttributionTurn>;
    readonly cwdOf: (key: string) => string | undefined;
  }): ReadonlyMap<ThreadId, ThreadUsage> => {
    const present = new Set<string>();
    const cpuDelta = new Map<string, number>();
    for (const process of input.processes) {
      const key = processKey(process);
      present.add(key);
      const previous = lastCpuMs.get(key);
      // A process first seen now counts in full only if it started since the
      // previous sample; older ones were running before we looked.
      const delta =
        previous !== undefined
          ? Math.max(0, process.cpuTimeMs - previous)
          : previousSampleAtMs !== undefined && process.startTimeMs >= previousSampleAtMs
            ? process.cpuTimeMs
            : 0;
      cpuDelta.set(key, delta);
      lastCpuMs.set(key, process.cpuTimeMs);
    }
    for (const key of lastCpuMs.keys()) if (!present.has(key)) lastCpuMs.delete(key);
    for (const key of owners.keys()) if (!present.has(key)) owners.delete(key);
    previousSampleAtMs = input.sampledAtMs;

    const rootOf = makeRootOf(serverPid, input.processes);
    const directories = input.turns.flatMap((turn) =>
      turn.directory === undefined ? [] : [turn.directory],
    );
    const directoryOf = (process: ProcessSample) => {
      const cwd = input.cwdOf(processKey(process));
      return cwd === undefined ? undefined : containingDirectory(cwd, directories);
    };

    // Where each root's descendants work.
    const descendantDirectories = new Map<string, Set<string>>();
    for (const process of input.processes) {
      if (process.ppid === serverPid) continue;
      const root = rootOf(process);
      const directory = root === undefined ? undefined : directoryOf(process);
      if (root === undefined || directory === undefined) continue;
      const rootKey = processKey(root);
      descendantDirectories.set(
        rootKey,
        (descendantDirectories.get(rootKey) ?? new Set()).add(directory),
      );
    }

    // Claims need positive evidence, never elimination: a root another
    // thread or the user started must not fall to whichever run is left.
    for (const root of input.processes) {
      const rootKey = processKey(root);
      if (root.ppid !== serverPid || owners.has(rootKey)) continue;
      if (IGNORED_ROOT_NAMES.has(root.name)) continue;
      const cwd = input.cwdOf(rootKey);
      if (cwd === undefined) continue;
      const own = containingDirectory(cwd, directories);
      const used = descendantDirectories.get(rootKey);
      const candidates =
        own !== undefined
          ? // Spawned in the directory by one of its runs in flight.
            input.turns.filter(
              (turn) =>
                turn.directory === own && root.startTimeMs >= turn.requestedAtMs - START_SLACK_MS,
            )
          : // Started elsewhere, but its commands run in one thread's directory.
            input.turns.filter(
              (turn) => turn.directory !== undefined && used?.has(turn.directory) === true,
            );
      const [only] = candidates;
      if (candidates.length === 1 && only !== undefined) owners.set(rootKey, only.threadId);
    }

    const active = new Set(input.turns.map((turn) => turn.threadId));
    const usage = new Map<ThreadId, { cpuMs: number; residentBytes: number }>();
    for (const process of input.processes) {
      const root = rootOf(process);
      const owner = root === undefined ? undefined : owners.get(processKey(root));
      if (owner === undefined || !active.has(owner)) continue;
      const current = usage.get(owner) ?? { cpuMs: 0, residentBytes: 0 };
      current.cpuMs += cpuDelta.get(processKey(process)) ?? 0;
      current.residentBytes += process.residentBytes;
      usage.set(owner, current);
    }
    return usage;
  };

  /**
   * Processes whose cwd can still decide an owner: everything outside a
   * tree that already has one. Saves `lsof` calls on a busy turn.
   */
  const needingCwd = (processes: ReadonlyArray<ProcessSample>) => {
    const rootOf = makeRootOf(serverPid, processes);
    return processes.filter((process) => {
      const root = rootOf(process);
      return root !== undefined && !owners.has(processKey(root));
    });
  };

  /**
   * Forgets CPU readings, so the next sample is a baseline. Call when no run
   * is in flight: CPU between runs belongs to no turn. Ownership is kept.
   */
  const reset = () => {
    lastCpuMs.clear();
    previousSampleAtMs = undefined;
  };

  return { sample, needingCwd, reset };
}
