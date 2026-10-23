// @effect-diagnostics nodeBuiltinImport:off - runs the pinned GNU Bash WASM through the Node JSPI gateway fixture.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";
import { describe, expect, it, vi } from "vite-plus/test";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import type { KernelBashForkSource } from "../../kernel/KernelBashFork.ts";
import { KERNEL_BASH_ARTIFACT } from "../../kernel/KernelBashProgram.ts";
import { createChildBash } from "../ChildBash.ts";
import { commandGatewayFixture, readAll, type FakeChildRun } from "../commandGatewayTesting.ts";
import { bashCredentials } from "./ChildBashFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const bashPath = new URL("../../../../../.t3/1071/programs/bash.wasm", import.meta.url);
const bashArtifactAvailable = NodeFS.existsSync(bashPath);
if (!bashArtifactAvailable && NodeProcess.env.SIGNALBOX_REQUIRE_BASH_ARTIFACT === "1") {
  throw new Error("GNU Bash slot tests require the pinned .t3/1071 Bash artifact");
}

const bashModule = bashArtifactAvailable ? loadPinnedBash() : undefined;
const SLOT_COUNT = 4;
const NESTED_FORK_DEPTH = 12;
const SUBSHELL_PIPELINE_STAGES = 15;

interface BashPortWithState extends KernelBashPort {
  metadata(): Promise<{ readonly pid: number; readonly residentByteLimit: number }>;
  forkSnapshot(): KernelBashForkSource | undefined;
}

function loadPinnedBash() {
  const bytes = NodeFS.readFileSync(bashPath);
  expect(bytes.byteLength).toBe(KERNEL_BASH_ARTIFACT.bytes);
  expect(NodeCrypto.createHash("sha256").update(bytes).digest("hex")).toBe(
    KERNEL_BASH_ARTIFACT.sha256,
  );
  return new WebAssembly.Module(bytes);
}

function createBashGateway() {
  const activeLoaderIds = new Set<string>();
  const seenLoaderIds = new Set<string>();
  const reactorPeaks: number[] = [];
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
      const port = await invocation.host<BashPortWithState>();
      const { pid, residentByteLimit } = await port.metadata();
      reactor = createChildBash({
        module: bashModule!,
        credentials: bashCredentials,
        pid,
        port,
        args: input.command.argv,
        env: input.command.env,
        snapshot: await port.forkSnapshot(),
        residentWasmBudgetBytes: residentByteLimit,
      });
      return await reactor.run();
    } finally {
      try {
        if (reactor !== undefined) {
          try {
            await reactor.drain();
          } finally {
            reactorPeaks.push(reactor.peakResidentWasmBytes);
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
    reactorPeaks,
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

async function runScript(fixture: ReturnType<typeof createBashGateway>["fixture"], script: string) {
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

function expectBoundedSlots(run: ReturnType<typeof createBashGateway>, residentByteLimit: number) {
  expect(run.maxLiveLoaderIds).toBeLessThanOrEqual(SLOT_COUNT);
  expect(run.activeLoaderIds.size).toBe(0);
  expect(run.workerRuns).toBeGreaterThan(0);
  expect(run.seenLoaderIds.size).toBeGreaterThan(0);
  expect(run.reactorPeaks.length).toBe(run.workerRuns);
  expect(run.reactorPeaks.every(Number.isSafeInteger)).toBe(true);
  expect(Math.max(...run.reactorPeaks)).toBeLessThanOrEqual(residentByteLimit);
  expect(run.fixture.capacity.active).toBe(0);
  expect(run.fixture.machineSpawn).not.toHaveBeenCalled();
}

describe.skipIf(!bashArtifactAvailable)("GNU Bash process slots through CommandGateway", () => {
  it("bounds deep forks, many waits, and a Bash subshell pipeline in four slots", async () => {
    const run = createBashGateway();
    const residentByteLimit = run.fixture.capacity.residentByteLimit;
    try {
      expect(run.fixture.capacity.limit).toBe(SLOT_COUNT);

      const nested = await runScript(
        run.fixture,
        [
          "build_tree() {",
          '  local depth="$1"',
          "  if (( depth == 0 )); then",
          "    printf '%s:%s\\n' \"$depth\" leaf > /workspace/gate/tree.result",
          "  else",
          '    (build_tree "$((depth - 1))")',
          "  fi",
          "}",
          `build_tree ${NESTED_FORK_DEPTH}`,
        ].join("\n"),
      );
      expect(nested).toEqual({
        stdout: "",
        stderr: "",
        status: { exitCode: 0, signal: 0, coreDumped: false },
      });
      expect(run.fixture.read("/workspace/gate/tree.result")).toBe("0:leaf\n");
      await run.fixture.gateway.drain();
      expectBoundedSlots(run, residentByteLimit);

      for (const children of [15, 40]) {
        const wait = await runScript(
          run.fixture,
          [
            "pids=()",
            `i=0; while (( i < ${children} )); do`,
            "  (printf 'job-%s\\n' \"$i\" > /workspace/gate/job-$i.out; printf '%s\\n' \"$?\" > /workspace/gate/job-$i.exit) &",
            '  pids+=("$!"); i=$((i + 1))',
            "done",
            "failures=0",
            'for pid in "${pids[@]}"; do wait "$pid" || failures=$((failures + 1)); done',
            'exit "$failures"',
          ].join("\n"),
        );
        expect(wait).toEqual({
          stdout: "",
          stderr: "",
          status: { exitCode: 0, signal: 0, coreDumped: false },
        });
        await run.fixture.gateway.drain();
        for (let index = 0; index < children; index++) {
          expect(run.fixture.read(`/workspace/gate/job-${index}.out`)).toBe(`job-${index}\n`);
          expect(run.fixture.read(`/workspace/gate/job-${index}.exit`)).toBe("0\n");
        }
        expectBoundedSlots(run, residentByteLimit);
      }

      const subshell = "(read -r x; printf '%s\\n' \"$x\")";
      const pipeline = [
        "printf '%s\\n' 'slot-pipeline-ok'",
        ...Array.from({ length: SUBSHELL_PIPELINE_STAGES }, () => subshell),
        "{ read -r last; printf '%s\\n' \"$last\"; }",
      ].join(" | ");
      const piped = await runScript(run.fixture, pipeline);
      expect(piped).toEqual({
        stdout: "slot-pipeline-ok\n",
        stderr: "",
        status: { exitCode: 0, signal: 0, coreDumped: false },
      });
      await run.fixture.gateway.drain();
      expectBoundedSlots(run, residentByteLimit);
    } finally {
      await run.fixture.close();
    }
  });
});
