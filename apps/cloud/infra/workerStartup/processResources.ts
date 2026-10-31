// @effect-diagnostics nodeBuiltinImport:off - These Node operations inspect only a captured profiler process group and its output directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { requireWorkerdLaunchAdmissionSync } from "../harnessReleases/workerdLaunchAdmission.ts";

export interface StartupProcessRow {
  readonly pid: number;
  readonly parentPid: number;
  readonly group: number;
  readonly rssBytes: number;
}

export interface StartupProcessAdapter {
  readonly spawn: typeof NodeChildProcess.spawn;
  readonly signalGroup: (group: number, signal: NodeJS.Signals) => void;
  readonly groupProcesses: (group: number) => Promise<StartupProcessRow[]>;
  readonly freeBytes: (path: string) => Promise<number>;
  readonly outputBytes: (directory: string) => Promise<number>;
  readonly admission: () => void;
  readonly now: () => number;
}

const executeFile = NodeUtil.promisify(NodeChildProcess.execFile);

export async function freeBytes(path: string) {
  const stats = await NodeFSP.statfs(path);
  return stats.bavail * stats.bsize;
}

async function outputBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const path = NodePath.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("WORKER_STARTUP_OUTPUT_SYMLINK");
    bytes += entry.isDirectory() ? await outputBytes(path) : (await NodeFSP.stat(path)).size;
  }
  return bytes;
}

async function groupProcesses(group: number): Promise<StartupProcessRow[]> {
  const { stdout } = await executeFile("/bin/ps", ["-axo", "pid=,ppid=,pgid=,rss="], {
    timeout: 5_000,
  });
  return stdout.split("\n").flatMap((line) => {
    const values = line.trim().split(/\s+/).map(Number);
    if (values.length !== 4 || values.some((value) => !Number.isFinite(value))) return [];
    const [pid, parentPid, pgid, rssKiB] = values;
    return pgid === group
      ? [{ pid: pid!, parentPid: parentPid!, group: pgid!, rssBytes: rssKiB! * 1_024 }]
      : [];
  });
}

export const defaultAdapter: StartupProcessAdapter = {
  spawn: NodeChildProcess.spawn,
  signalGroup(group, signal) {
    try {
      process.kill(-group, signal);
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
    }
  },
  groupProcesses,
  freeBytes,
  outputBytes,
  admission: requireWorkerdLaunchAdmissionSync,
  now: () => performance.now(),
};
