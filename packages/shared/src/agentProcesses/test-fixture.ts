// @effect-diagnostics nodeBuiltinImport:off - Builds isolated Node worktrees and process fixtures.
import { afterEach, vi } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { createAgentProcessRegistry } from "./registry.ts";

const tempDirectories: Array<string> = [];

export const makeFixture = () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "signalbox-agent-processes-"));
  const worktreePath = NodePath.join(root, "worktree");
  const commonDir = NodePath.join(root, "common.git");
  NodeFS.mkdirSync(worktreePath, { recursive: true });
  NodeFS.mkdirSync(commonDir, { recursive: true });
  const canonicalWorktreePath = NodeFS.realpathSync(worktreePath);
  tempDirectories.push(root);
  const processes = new Map<
    number,
    { identity: { platform: NodeJS.Platform; bootId: string; startTime: string }; cwd: string }
  >();
  const metrics = new Map<
    number,
    { cpuPercent?: number; rssBytes?: number; listeningPorts?: ReadonlyArray<number> }
  >();
  const signals: Array<{ pid: number; signal: "SIGTERM" | "SIGKILL" }> = [];
  const events: Array<string> = [];
  const waits: Array<(milliseconds: number) => void | Promise<void>> = [];
  let terminateOnSignal = true;
  const fixtureProcessIdentity = {
    platform: "linux" as const,
    bootId: "boot-1",
    startTime: "fixture-process",
  };
  const processOps = {
    identify: vi.fn(
      async (pid: number) =>
        processes.get(pid)?.identity ?? (pid === process.pid ? fixtureProcessIdentity : undefined),
    ),
    inspect: vi.fn(async (pid: number) => {
      const current = processes.get(pid);
      if (current === undefined && pid === process.pid) {
        return {
          state: "running" as const,
          identity: fixtureProcessIdentity,
          cwd: canonicalWorktreePath,
        };
      }
      return current === undefined
        ? { state: "missing" as const }
        : { state: "running" as const, identity: current.identity, cwd: current.cwd };
    }),
    metrics: vi.fn(
      async (pids: ReadonlyArray<number>) =>
        new Map(
          pids.flatMap((pid) => (metrics.has(pid) ? [[pid, metrics.get(pid)!] as const] : [])),
        ),
    ),
    sendSignal: vi.fn((pid: number, signal: "SIGTERM" | "SIGKILL") => {
      signals.push({ pid, signal });
      events.push(signal);
      if (terminateOnSignal) processes.delete(pid);
    }),
    wait: vi.fn(async (milliseconds: number) => {
      for (const onWait of waits) await onWait(milliseconds);
    }),
  };
  const registry = createAgentProcessRegistry({
    commonDirResolver: () => commonDir,
    processOps,
  });
  const addProcess = (
    pid: number,
    options: { cwd?: string; bootId?: string; startTime?: string } = {},
  ) => {
    processes.set(pid, {
      identity: {
        platform: "linux",
        bootId: options.bootId ?? "boot-1",
        startTime: options.startTime ?? String(pid),
      },
      cwd: options.cwd ?? canonicalWorktreePath,
    });
  };
  return {
    root,
    worktreePath: canonicalWorktreePath,
    commonDir,
    processOps,
    registry,
    processes,
    signals,
    events,
    metrics,
    waits,
    addProcess,
    setTerminateOnSignal: (value: boolean) => {
      terminateOnSignal = value;
    },
  };
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
