import { expect, it, vi } from "vite-plus/test";
import type { KernelBashForkSource, KernelBashForkState } from "../../kernel/KernelBashFork.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { BashWorkerPhase } from "../BashWorkerPhase.ts";
import { ChildWorkerCapacity } from "../ChildWorkerCapacity.ts";
import { createTestFilesystem } from "./helpers/filesystem.ts";
import { withRpcReplyDisposer } from "./helpers/rpcReply.ts";

const state: KernelBashForkState = {
  version: 1,
  memoryBytes: 0,
  stackPointer: 16,
  continuation: { resume: 0 },
  captures: {
    stack: { low: 0, high: 0, log: 0 },
    base: 0,
    size: 0,
    names: [],
    stackNames: [],
    captures: [],
    top: 0,
    liveBytes: 0,
    nextId: 1,
    nextGeneration: 1,
  },
};

it.each(["placed", "parked"] as const)(
  "releases the ignored %s fork completion reply",
  async (mode) => {
    const fixture = createTestFilesystem();
    const dispose = vi.fn();
    const jobs: (() => Promise<void>)[] = [];
    const source: KernelBashForkSource = {
      state: async () => state,
      read: async () => new Uint8Array(),
      restored: async () => {},
    };
    const port: KernelBashPort = {
      call: async () => ({ kind: "return", value: 0, regions: [] }),
      callBash: async () => ({ value: 0, regions: [] }),
      fork: async () => ({ kind: "error", errno: 6 }),
      wait: async () => ({ kind: "wait", pid: 0 }),
      exec: async () => ({ kind: "error", errno: 6 }),
      complete: async () => {},
      runFork: async () =>
        withRpcReplyDisposer({ exitCode: 0, signal: 0, coreDumped: false }, dispose),
    };
    const controller = new AbortController();
    const phase = new BashWorkerPhase({
      filesystem: fixture.filesystem,
      rootPid: 12,
      signal: controller.signal,
      startFork: (work) => jobs.push(work),
    });
    try {
      if (mode === "placed") await phase.placeFork(port, 13, source);
      else {
        await phase.park(port, 13, source);
        const capacity = new ChildWorkerCapacity(1, { owner: "test/phase-reply-drop" });
        const permit = await capacity.acquire(controller.signal, undefined);
        try {
          await phase.stopped(permit.execution);
        } finally {
          await permit.release();
        }
      }
      expect(jobs).toHaveLength(1);
      await jobs[0]!();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      fixture.close();
    }
  },
);

it("releases state replies used while parking and storing a Bash checkpoint", async () => {
  const fixture = createTestFilesystem();
  const disposeReply = vi.fn();
  const source: KernelBashForkSource = {
    async state() {
      return withRpcReplyDisposer({ ...state }, disposeReply);
    },
    read: async () => new Uint8Array(),
    restored: async () => {},
  };
  const phase = new BashWorkerPhase({
    filesystem: fixture.filesystem,
    rootPid: 12,
    signal: new AbortController().signal,
    startFork: () => {},
  });
  try {
    await phase.park({} as KernelBashPort, 12, source);
    expect(disposeReply).toHaveBeenCalledTimes(2);
    const checkpoint = phase.root!.checkpoint;
    const saved = await checkpoint.source().state();
    expect(saved).toEqual(state);
    expect(Symbol.dispose in saved).toBe(false);
    await checkpoint.close();
  } finally {
    fixture.close();
  }
});
