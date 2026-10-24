// @effect-diagnostics nodeBuiltinImport:off - reads the pinned local GNU Bash artifact.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import { createKernelBashHost } from "../../kernel/KernelBashHost.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { createChildBash } from "../ChildBash.ts";
import { ChildHostLease } from "../ChildHostLease.ts";
import {
  createWorkerBashForkHost,
  createWorkerBashHost,
  type WorkerBashPhase,
} from "../WorkerBashHost.ts";
import { bashCredentials, childBashFixture, exited } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const artifact = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const available = NodeFS.existsSync(artifact);
if (!available && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1")
  throw new Error("Bash slot residency requires the pinned GNU Bash artifact");

const GROWTH_SCRIPT = [
  "(printf -v x '%*s' 25000000 ''; printf '%s\\n' \"${#x}\"; read -r -t0.01 line) &",
  "(printf -v x '%*s' 25000000 ''; printf '%s\\n' \"${#x}\"; read -r -t0.01 line) &",
  "wait",
].join("\n");

async function runGrowthScenario(options: {
  readonly residentWasmBudgetBytes: number;
  readonly localForkPackingBytes: number;
  readonly script?: string;
}) {
  const bytes = NodeFS.readFileSync(artifact);
  expect(bytes.byteLength).toBe(KERNEL_BASH_ARTIFACT.bytes);
  expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(
    KERNEL_BASH_ARTIFACT.sha256,
  );
  const module = new WebAssembly.Module(bytes);
  const fixture = childBashFixture({
    args: ["bash", "--noprofile", "--norc", "-c", options.script ?? GROWTH_SCRIPT],
  });
  const observations: number[] = [];
  const migrationObservedBytes: number[] = [];
  const remotePeaks: Array<{ observed: number; resident: number }> = [];
  const placementErrors: unknown[] = [];
  const placementTasks: Promise<void>[] = [];
  const lease = new ChildHostLease((residentBytes) => observations.push(residentBytes));
  const owner = createKernelBashHost({ context: fixture.context, credentials: bashCredentials });
  const place = (port: KernelBashPort, pid: number, source: KernelBashForkSource) => {
    migrationObservedBytes.push(Math.max(0, ...observations));
    const placed = createChildBash({
      module,
      credentials: bashCredentials,
      pid,
      port,
      args: fixture.context.args,
      env: fixture.context.env,
      snapshot: source,
      residentWasmBudgetBytes: options.residentWasmBudgetBytes,
      localForkPackingBytes: options.localForkPackingBytes,
    });
    const task = (async () => {
      try {
        await placed.run();
        await placed.drain();
        remotePeaks.push({
          observed: placed.peakObservedResidentWasmBytes,
          resident: placed.peakResidentWasmBytes,
        });
      } catch (error) {
        placementErrors.push(error);
      }
    })();
    placementTasks.push(task);
  };
  const phase: WorkerBashPhase = {
    async startOperation(port, operation) {
      if (operation.kind === "wasi")
        return {
          kind: "ready",
          result: { kind: "wasi", value: await port.call(operation.request) },
        };
      if (operation.kind === "bash")
        return {
          kind: "ready",
          result: { kind: "bash", value: await port.callBash(operation.request) },
        };
      if (operation.kind === "wait")
        return {
          kind: "ready",
          result: { kind: "wait", value: await port.wait(operation.pid, operation.options) },
        };
      return {
        kind: "ready",
        result: { kind: "exec", value: await port.exec(operation.request) },
      };
    },
    async park(port, pid, source) {
      place(port, pid, source);
    },
    async placeFork(port, pid, source) {
      place(port, pid, source);
    },
  };
  const worker = createWorkerBashForkHost(
    { context: fixture.context, credentials: bashCredentials },
    lease,
    owner,
    undefined,
    phase,
    options.residentWasmBudgetBytes,
  );
  const reactor = createChildBash({
    module,
    credentials: bashCredentials,
    pid: fixture.owner.pid,
    port: worker.host,
    args: fixture.context.args,
    env: fixture.context.env,
    residentWasmBudgetBytes: options.residentWasmBudgetBytes,
    localForkPackingBytes: options.localForkPackingBytes,
  });
  try {
    const status = await reactor.run();
    await reactor.drain();
    await Promise.all(placementTasks);
    expect(placementErrors).toEqual([]);
    return {
      stderr: fixture.stderr(),
      stdout: fixture.stdout(),
      status,
      migrationObservedBytes,
      observed: reactor.peakObservedResidentWasmBytes,
      resident: reactor.peakResidentWasmBytes,
      remotePeaks,
    };
  } finally {
    lease.release();
    await worker.close();
    await fixture.close();
  }
}

describe.skipIf(!available)("Bash slot residency", () => {
  it("reports all local fork memories through one physical slot's syscall observations", async () => {
    const bytes = NodeFS.readFileSync(artifact);
    expect(bytes.byteLength).toBe(KERNEL_BASH_ARTIFACT.bytes);
    expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(
      KERNEL_BASH_ARTIFACT.sha256,
    );
    const fixture = childBashFixture({
      args: ["bash", "--noprofile", "--norc", "-c", "(printf child) & wait"],
    });
    const observations: number[] = [];
    const lease = new ChildHostLease((residentBytes) => observations.push(residentBytes));
    const worker = createWorkerBashHost(
      { context: fixture.context, credentials: bashCredentials },
      lease,
    );
    const reactor = createChildBash({
      module: new WebAssembly.Module(bytes),
      credentials: bashCredentials,
      pid: fixture.owner.pid,
      port: worker.host,
      args: fixture.context.args,
      env: fixture.context.env,
    });
    try {
      expect(await reactor.run()).toEqual(exited());
      await reactor.drain();
      expect(fixture.stdout()).toBe("child");
      expect(reactor.peakResidentWasmBytes).toBeGreaterThan(32 * 1024 * 1024);
      expect(Math.max(...observations)).toBe(reactor.peakResidentWasmBytes);
    } finally {
      lease.release();
      await worker.close();
      await fixture.close();
    }
  });

  it("moves the second 25,000,000-byte Bash string before raw slot residency exceeds 104 MiB", async () => {
    const baseline = await runGrowthScenario({
      residentWasmBudgetBytes: 512 * 1024 * 1024,
      localForkPackingBytes: 512 * 1024 * 1024,
    });
    expect(baseline.stderr).toBe("");
    expect(baseline.stdout).toBe("25000000\n25000000\n");
    expect(baseline.migrationObservedBytes).toEqual([]);
    expect(baseline.observed).toBe(152_109_056);
    expect(baseline.resident).toBe(152_109_056);

    const placed = await runGrowthScenario({
      residentWasmBudgetBytes: 104 * 1024 * 1024,
      localForkPackingBytes: 64 * 1024 * 1024,
    });
    const slotBudget = 104 * 1024 * 1024;
    const observedPeaks = [placed.observed, ...placed.remotePeaks.map((peak) => peak.observed)];
    const residentPeaks = [placed.resident, ...placed.remotePeaks.map((peak) => peak.resident)];
    expect(placed.stderr).toBe(baseline.stderr);
    expect(placed.stdout).toBe(baseline.stdout);
    expect(placed.status).toEqual(baseline.status);
    expect(placed.migrationObservedBytes[0]).toBe(102_105_088);
    expect(placed.migrationObservedBytes.length).toBeGreaterThan(0);
    expect(Math.max(...observedPeaks)).toBeLessThanOrEqual(slotBudget);
    expect(Math.max(...residentPeaks)).toBeLessThanOrEqual(slotBudget);
  });

  it("lets one unplaceable Bash process exceed a slot budget without a guest memory error", async () => {
    const scenario = await runGrowthScenario({
      residentWasmBudgetBytes: 104 * 1024 * 1024,
      localForkPackingBytes: 64 * 1024 * 1024,
      script: "printf -v x '%*s' 50000000 ''; printf '%s\\n' \"${#x}\"",
    });
    expect(scenario.status.signal).toBe(0);
    expect(scenario.stderr).not.toMatch(/exceededMemory|memory limit/i);
    expect(scenario.stdout).toBe("50000000\n");
    expect(scenario.migrationObservedBytes).toHaveLength(1);
    expect(scenario.remotePeaks[0]?.observed).toBeGreaterThan(104 * 1024 * 1024);
    expect(scenario.remotePeaks[0]?.resident).toBeGreaterThan(104 * 1024 * 1024);
  });
});
