// @effect-diagnostics nodeBuiltinImport:off - runs the pinned GNU Bash WASM through the command gateway fixture.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { expect } from "vite-plus/test";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import { createChildBash } from "../ChildBash.ts";
import { commandGatewayFixture, readAll, type FakeChildRun } from "../commandGatewayTesting.ts";
import { bashCredentials } from "./ChildBashFixture.ts";
import {
  traceForkPort,
  type BashForkTraceEvent,
  type BashPortWithState,
} from "./ChildBashForkTrace.ts";

const bashPath = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
export const bashArtifactAvailable = NodeFS.existsSync(bashPath);
if (!bashArtifactAvailable && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1") {
  throw new Error("GNU Bash slot tests require the pinned .t3/1071 Bash artifact");
}

export const bashModule = bashArtifactAvailable ? loadPinnedBash() : undefined;
export const SLOT_COUNT = 4;

interface SnapshotReceipt {
  readonly order: string[];
  restored: number;
  disposed: number;
}

type DisposableForkSource = KernelBashForkSource & {
  [Symbol.dispose](): void;
};

function loadPinnedBash() {
  const bytes = NodeFS.readFileSync(bashPath);
  expect(bytes.byteLength).toBe(KERNEL_BASH_ARTIFACT.bytes);
  expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(
    KERNEL_BASH_ARTIFACT.sha256,
  );
  return new WebAssembly.Module(bytes);
}

export function createBashGateway() {
  const activeLoaderIds = new Set<string>();
  const seenLoaderIds = new Set<string>();
  const reactorPeaks: number[] = [];
  const reactorObservedPeaks: number[] = [];
  const reactorPostEnforcementPeaks: number[] = [];
  const forkTrace: BashForkTraceEvent[] = [];
  const snapshotReceipts: SnapshotReceipt[] = [];
  let maxLiveLoaderIds = 0;
  let workerRuns = 0;

  const run: FakeChildRun = async (input, invocation) => {
    if (input.command.executable !== "/bin/bash") {
      throw new Error(`Unexpected child executable: ${input.command.executable}`);
    }
    if (activeLoaderIds.has(input.loaderId)) {
      throw new Error(`Concurrent Bash workers reused loader ID ${input.loaderId}`);
    }

    activeLoaderIds.add(input.loaderId);
    seenLoaderIds.add(input.loaderId);
    workerRuns++;
    maxLiveLoaderIds = Math.max(maxLiveLoaderIds, activeLoaderIds.size);
    let reactor: ReturnType<typeof createChildBash> | undefined;
    try {
      const host = await invocation.host<BashPortWithState>();
      const { pid, residentByteLimit } = await host.metadata();
      const port = traceForkPort(host, pid, forkTrace);
      const sourceSnapshot = await port.forkSnapshot();
      const receipt: SnapshotReceipt = { order: [], restored: 0, disposed: 0 };
      const snapshot: DisposableForkSource | undefined =
        sourceSnapshot === undefined
          ? undefined
          : {
              state: () => sourceSnapshot.state(),
              read: (offset, length) => sourceSnapshot.read(offset, length),
              async restored() {
                await sourceSnapshot.restored();
                receipt.restored++;
                receipt.order.push("restored");
              },
              [Symbol.dispose]() {
                receipt.disposed++;
                receipt.order.push("dispose");
              },
            };
      if (snapshot !== undefined) snapshotReceipts.push(receipt);
      reactor = createChildBash({
        module: bashModule!,
        credentials: bashCredentials,
        pid,
        port,
        args: input.command.argv,
        env: input.command.env,
        snapshot,
        residentWasmBudgetBytes: residentByteLimit,
        createForkSource(source) {
          return {
            async state() {
              const state = await source.state();
              const pending = state.continuation.pending;
              forkTrace.push({
                event: "source-state",
                pid,
                memoryBytes: state.memoryBytes,
                stackPointer: state.stackPointer,
                captureTop: state.captures.top,
                resume: state.continuation.resume,
                pending: pending?.kind,
                role: pending?.kind === "fork" ? pending.role : undefined,
                operationId: state.continuation.operationId,
                result: state.continuation.result,
              });
              return state;
            },
            read: (offset, length) => source.read(offset, length),
            async restored() {
              forkTrace.push({ event: "source-restored", pid });
              return source.restored();
            },
          };
        },
      });
      return await reactor.run();
    } finally {
      try {
        if (reactor !== undefined) {
          try {
            await reactor.drain();
          } finally {
            reactorPeaks.push(reactor.peakResidentWasmBytes);
            reactorObservedPeaks.push(reactor.peakObservedResidentWasmBytes);
            reactorPostEnforcementPeaks.push(reactor.peakPostEnforcementResidentWasmBytes);
          }
        }
      } finally {
        activeLoaderIds.delete(input.loaderId);
        invocation.acknowledge();
      }
    }
  };

  const fixture = commandGatewayFixture({ capacityLimit: SLOT_COUNT, run });
  fixture.filesystem.mkdir("/workspace/gate");
  fixture.filesystem.mkdir("/bin");
  fixture.write("/bin/bash", "", 0o755);
  return {
    fixture,
    forkTrace,
    reactorPeaks,
    reactorObservedPeaks,
    reactorPostEnforcementPeaks,
    snapshotReceipts,
    get activeLoaderIds() {
      return activeLoaderIds;
    },
    get seenLoaderIds() {
      return seenLoaderIds;
    },
    get maxLiveLoaderIds() {
      return maxLiveLoaderIds;
    },
    get workerRuns() {
      return workerRuns;
    },
  };
}

export async function runBashScript(
  fixture: ReturnType<typeof createBashGateway>["fixture"],
  script: string,
) {
  const child = await fixture.gateway.exec(
    {
      executable: "/bin/bash",
      argv: ["bash", "--noprofile", "--norc", "-c", script],
      cwd: "/workspace",
      env: { HOME: "/workspace", PATH: "/bin" },
    },
    fixture.controller.signal,
    undefined,
  );
  try {
    const [stdout, stderr, status] = await Promise.all([
      readAll(child.stdout),
      readAll(child.stderr),
      child.exited,
    ]);
    return {
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
      status,
    };
  } finally {
    await child.dispose();
  }
}

export function expectBoundedSlots(
  run: ReturnType<typeof createBashGateway>,
  residentByteLimit: number,
) {
  expect(run.maxLiveLoaderIds).toBeLessThanOrEqual(SLOT_COUNT);
  expect(run.activeLoaderIds.size).toBe(0);
  expect(run.workerRuns).toBeGreaterThan(0);
  expect(run.seenLoaderIds.size).toBeGreaterThan(0);
  expect(run.reactorPeaks.length).toBe(run.workerRuns);
  expect(run.reactorPeaks.every(Number.isSafeInteger)).toBe(true);
  expect(Math.max(...run.reactorPeaks)).toBeLessThanOrEqual(residentByteLimit);
  expect(run.fixture.capacity.active).toBe(0);
  expect(run.fixture.machineSpawn).not.toHaveBeenCalled();
  expect(run.snapshotReceipts.length).toBeGreaterThan(0);
  for (const receipt of run.snapshotReceipts) {
    expect(receipt.restored).toBe(1);
    expect(receipt.disposed).toBe(1);
    expect(receipt.order).toEqual(["restored", "dispose"]);
  }
}
