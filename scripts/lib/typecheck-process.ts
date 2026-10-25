// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - measures native process trees outside Effect fibers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

const platform = Effect.runSync(HostProcess.Platform);
export const sampleIntervalMs = 50;

export interface ProcessStatus {
  pid: number;
  ppid: number;
  rssBytes: number;
}

interface ProcessIdentity {
  startTime: string;
  processGroup: number;
}

interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  wallMilliseconds: number;
  peakAggregateRssBytes: number;
}

function errorCode(error: unknown) {
  return error && typeof error === "object" ? Reflect.get(error, "code") : undefined;
}

export function parseProcessStatus(pid: number, text: string): ProcessStatus | undefined {
  const ppid = /^PPid:\s+(\d+)$/m.exec(text);
  if (!ppid) return undefined;
  const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text);
  return { pid, ppid: Number(ppid[1]), rssBytes: rss ? Number(rss[1]) * 1024 : 0 };
}

export function aggregateProcessTreeRss(statuses: readonly ProcessStatus[], rootPid: number) {
  const byPid = new Map(statuses.map((status) => [status.pid, status]));
  const children = new Map<number, number[]>();
  for (const status of statuses) {
    const pids = children.get(status.ppid) ?? [];
    pids.push(status.pid);
    children.set(status.ppid, pids);
  }
  let total = 0;
  const pending = [rootPid];
  const seen = new Set<number>();
  while (pending.length) {
    const pid = pending.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const status = byPid.get(pid);
    if (status) {
      total += status.rssBytes;
      pending.push(...(children.get(pid) ?? []));
    }
  }
  return total;
}

function readIdentity(pid: number): ProcessIdentity | undefined {
  let text: string;
  try {
    text = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  const fields = text
    .slice(text.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  return { processGroup: Number(fields[2]), startTime: fields[19]! };
}

function signalOwnedGroup(pid: number, identity: ProcessIdentity, signal: NodeJS.Signals) {
  const current = readIdentity(pid);
  if (!current || current.startTime !== identity.startTime || current.processGroup !== pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

function processStatuses() {
  const result: ProcessStatus[] = [];
  for (const entry of NodeFS.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = parseProcessStatus(
        Number(entry),
        NodeFS.readFileSync(`/proc/${entry}/status`, "utf8"),
      );
      if (status) result.push(status);
    } catch (error) {
      if (errorCode(error) !== "ENOENT" && errorCode(error) !== "ESRCH") throw error;
    }
  }
  return result;
}

function startRssSampler(pid: number, identity: ProcessIdentity) {
  let peak = 0;
  let failure: unknown;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const sample = () => {
    if (stopped) return;
    try {
      const current = readIdentity(pid);
      if (current?.startTime === identity.startTime && current.processGroup === pid)
        peak = Math.max(peak, aggregateProcessTreeRss(processStatuses(), pid));
    } catch (error) {
      failure = error;
      stopped = true;
    }
    if (!stopped) timer = setTimeout(sample, sampleIntervalMs);
  };
  sample();
  return {
    peak: () => peak,
    failure: () => failure,
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export class BenchmarkInterrupted extends Error {
  readonly signalName: string;

  constructor(signalName: string) {
    super(`Benchmark interrupted by ${signalName}`);
    this.signalName = signalName;
  }
}

export async function runTypecheck(root: string, signal: AbortSignal): Promise<RunResult> {
  if (platform !== "linux") throw new Error("The typecheck benchmark requires Linux /proc");
  if (signal.aborted) throw new BenchmarkInterrupted(String(signal.reason));
  const startedAt = performance.now();
  const child = NodeChildProcess.spawn(
    NodePath.join(root, "node_modules/.bin/vp"),
    ["run", "typecheck"],
    {
      cwd: root,
      detached: true,
      stdio: "inherit",
    },
  );
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  const closed = new Promise<
    { code: number | null; signal: NodeJS.Signals | null } | { error: Error }
  >((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, childSignal) => resolve({ code, signal: childSignal }));
  });

  let childClosed = false;
  let identity: ProcessIdentity | undefined;
  let sampler: ReturnType<typeof startRssSampler> | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const stopGroup = () => {
    if (!identity || !child.pid) return;
    signalOwnedGroup(child.pid, identity, signal.reason === "SIGTERM" ? "SIGTERM" : "SIGINT");
    forceKillTimer = setTimeout(() => signalOwnedGroup(child.pid!, identity!, "SIGKILL"), 5000);
  };
  signal.addEventListener("abort", stopGroup);
  try {
    await spawned;
    if (!child.pid) throw new Error("Vite CLI started without a child PID");
    identity = readIdentity(child.pid);
    if (!identity || identity.processGroup !== child.pid)
      throw new Error(`Could not validate Vite CLI process group for PID ${child.pid}`);
    sampler = startRssSampler(child.pid, identity);
    if (signal.aborted) stopGroup();
    const result = await closed;
    childClosed = true;
    if ("error" in result) throw result.error;
    if (signal.aborted) throw new BenchmarkInterrupted(String(signal.reason));
    if (sampler.failure()) throw sampler.failure();
    return {
      exitCode: result.code,
      signal: result.signal,
      wallMilliseconds: performance.now() - startedAt,
      peakAggregateRssBytes: sampler.peak(),
    };
  } finally {
    signal.removeEventListener("abort", stopGroup);
    sampler?.stop();
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (!childClosed && child.pid && identity) signalOwnedGroup(child.pid, identity, "SIGTERM");
  }
}
