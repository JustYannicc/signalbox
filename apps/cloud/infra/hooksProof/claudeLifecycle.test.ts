import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { kernelError } from "../../src/kernel/KernelAbi.ts";
import { KernelCpuAccounting } from "../../src/kernel/KernelCpuAccounting.ts";
import { KernelCpuExecution } from "../../src/kernel/KernelCpuExecution.ts";
import { KernelProcessTable, type KernelExitStatus } from "../../src/kernel/KernelProcessTable.ts";
import { KernelWakeRegistry } from "../../src/kernel/KernelWakeRegistry.ts";
import { createGuestObservation } from "../claudeTurnProof/proofObservation.ts";
import { terminalSuccess } from "../claudeTurnProof/proofScenario.ts";
import { createClaudeProofCleanup, runClaudeProofLifecycle } from "./claudeLifecycle.ts";

function fixture() {
  const events = new EventTarget();
  vi.stubGlobal("addEventListener", events.addEventListener.bind(events));
  vi.stubGlobal("removeEventListener", events.removeEventListener.bind(events));
  const originalConsole = globalThis.console;
  const originalFetch = globalThis.fetch;
  const observation = createGuestObservation();
  globalThis.fetch = async () => new Response("proof mock");
  const cpuRoot = new KernelCpuExecution(new KernelCpuAccounting(() => 1n)).root;
  const processes = new KernelProcessTable({ wakes: new KernelWakeRegistry() });
  const cleanup = createClaudeProofCleanup(processes, cpuRoot);
  const launch = Promise.withResolvers<void>();
  const retained: Promise<void>[] = [];
  const restore = () => {
    try {
      globalThis.fetch = originalFetch;
    } finally {
      observation.restore();
    }
  };
  return {
    observation,
    cpuRoot,
    processes,
    cleanup,
    launch,
    retained,
    originalConsole,
    originalFetch,
    restore,
    success() {
      observation.streams.stdout.write(
        JSON.stringify({ type: "result", subtype: "success", is_error: false }) + "\n",
      );
    },
    start() {
      return runClaudeProofLifecycle({
        runtime: { ...cleanup, cpuRoot, enterUser: () => cpuRoot.enterUser() },
        launch: () => launch.promise,
        terminal: observation.done,
        guestError: observation.guestError,
        restore,
        retain: (lifetime) => retained.push(lifetime),
      });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Claude proof lifetime", () => {
  it("leaves the real CPU scope before closing a completed launch", async () => {
    const test = fixture();
    try {
      const running = test.start();
      test.success();
      test.launch.resolve();
      expect(await running).toMatchObject({
        deadlineExceeded: false,
        launchSettled: true,
        cleanup: "complete",
      });
      expect(terminalSuccess(test.observation.output)).toBe(true);
      expect(() => test.cpuRoot.run(() => undefined)).toThrow("stopped");
      expect(globalThis.fetch).toBe(test.originalFetch);
      expect(globalThis.console).toBe(test.originalConsole);
      expect(test.cleanup.close()).toBe(test.cleanup.close());
      await test.cleanup.close();
    } finally {
      test.restore();
    }
  });

  it("keeps an early success pending and rejects a later launch failure", async () => {
    const test = fixture();
    try {
      let returned = false;
      const running = test.start().then((result) => {
        returned = true;
        return result;
      });
      test.success();
      await test.observation.done;
      expect(returned).toBe(false);
      expect(terminalSuccess(test.observation.output)).toBe(true);
      test.launch.reject(new Error("late launch rejection"));
      await running;
      expect(test.observation.output.errors).toContainEqual(
        expect.objectContaining({ message: "late launch rejection" }),
      );
      expect(terminalSuccess(test.observation.output)).toBe(false);
    } finally {
      test.restore();
    }
  });

  it("reports an unsettled launch at exactly 20s and retains ownership through physical drain", async () => {
    vi.useFakeTimers();
    const test = fixture();
    const child = Promise.withResolvers<KernelExitStatus>();
    const signalled = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    test.processes.spawn(
      undefined,
      () => ({
        completion: child.promise,
        signal() {
          signalled.resolve();
          return { status: "ok", value: undefined };
        },
      }),
      () => released.resolve(),
    );
    try {
      let receipt: Awaited<ReturnType<typeof test.start>> | undefined;
      const running = test.start().then((result) => {
        receipt = result;
        return result;
      });
      test.success();
      await vi.advanceTimersByTimeAsync(19_999);
      expect(receipt).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(receipt).toMatchObject({
        deadlineExceeded: true,
        launchSettled: false,
        cleanup: "pending",
      });
      expect(test.observation.output.milestones).toContain("launch-unsettled");
      expect(terminalSuccess(test.observation.output)).toBe(false);
      await signalled.promise;
      expect(test.processes.size).toBe(1);
      expect(globalThis.fetch).not.toBe(test.originalFetch);
      expect(globalThis.console).not.toBe(test.originalConsole);
      expect(() => test.cpuRoot.runUser(() => undefined)).not.toThrow();
      expect(test.retained).toHaveLength(1);

      child.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      await released.promise;
      await test.cleanup.cancelOwnedWork();
      expect(test.processes.size).toBe(0);
      expect(globalThis.fetch).not.toBe(test.originalFetch);
      expect(() => test.cpuRoot.runUser(() => undefined)).not.toThrow();
      test.launch.resolve();
      await Promise.all(test.retained);
      await running;
      expect(globalThis.fetch).toBe(test.originalFetch);
      expect(globalThis.console).toBe(test.originalConsole);
      expect(() => test.cpuRoot.runUser(() => undefined)).toThrow("stopped");
    } finally {
      child.resolve({ exitCode: 0, signal: 0, coreDumped: false });
      test.launch.resolve();
      test.restore();
    }
  });

  it("also requires terminal observation after launch returns", async () => {
    vi.useFakeTimers();
    const test = fixture();
    try {
      const running = test.start();
      test.launch.resolve();
      await vi.advanceTimersByTimeAsync(19_999);
      expect(globalThis.console).not.toBe(test.originalConsole);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toMatchObject({ deadlineExceeded: true, launchSettled: true });
      expect(test.observation.output.milestones).not.toContain("launch-unsettled");
      expect(test.observation.output.milestones).toContain("deadline");
      await Promise.all(test.retained);
    } finally {
      test.restore();
    }
  });

  it("accepts terminal success arriving after the launch has returned", async () => {
    vi.useFakeTimers();
    const test = fixture();
    try {
      const running = test.start();
      test.launch.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(globalThis.fetch).not.toBe(test.originalFetch);
      expect(() => test.cpuRoot.run(() => undefined)).not.toThrow();
      test.success();
      expect(await running).toMatchObject({
        deadlineExceeded: false,
        cleanup: "complete",
        mockGlobalsRestored: true,
      });
      expect(terminalSuccess(test.observation.output)).toBe(true);
      expect(test.retained).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      test.restore();
    }
  });

  it("restores fetch and observation even when process cleanup fails", async () => {
    const test = fixture();
    vi.spyOn(test.processes, "dispose").mockResolvedValue(
      kernelError("IO_ERROR", "runtime refused termination"),
    );
    try {
      const running = test.start();
      test.success();
      test.launch.resolve();
      expect(await running).toMatchObject({ cleanup: "failed" });
      expect(test.observation.output.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining("runtime refused termination"),
        }),
      );
      expect(terminalSuccess(test.observation.output)).toBe(false);
      expect(globalThis.fetch).toBe(test.originalFetch);
      expect(globalThis.console).toBe(test.originalConsole);
    } finally {
      test.restore();
    }
  });
});
