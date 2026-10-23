// @effect-diagnostics nodeBuiltinImport:off - reads the pinned local GNU Bash artifact.
import { describe, expect, it, vi } from "vite-plus/test";
import { createKernelBashProgram } from "../../kernel/KernelBashProgram.ts";
import { bashCredentials, childBashFixture } from "./ChildBashFixture.ts";
import {
  bashArtifactAvailable,
  bashModule,
  createBashGateway,
  expectBoundedSlots,
  runBashScript,
  SLOT_COUNT,
} from "./ChildBashGatewayFixture.ts";

vi.mock("cloudflare:workers", () => ({ RpcTarget: Object }));

const NESTED_FORK_DEPTH = 12;
const LEGACY_FORK_DEPTH = 1;
const SUBSHELL_PIPELINE_STAGES = 15;

describe.skipIf(!bashArtifactAvailable)("GNU Bash process slots through CommandGateway", () => {
  it("preserves the same-isolate recursive fork leaf output", async () => {
    const fixture = childBashFixture({
      args: [
        "bash",
        "--noprofile",
        "--norc",
        "-c",
        [
          "build_tree() {",
          '  local depth="$1"',
          "  if (( depth == 0 )); then",
          "    printf '%s:%s\\n' \"$depth\" leaf > /workspace/gate/tree.result",
          "  else",
          '    (build_tree "$((depth - 1))")',
          "  fi",
          "}",
          `build_tree ${LEGACY_FORK_DEPTH}`,
        ].join("\n"),
      ],
      env: { HOME: "/workspace", PATH: "/bin" },
    });
    fixture.filesystem.mkdir("/workspace/gate");
    try {
      const fallback = createKernelBashProgram({
        module: bashModule!,
        credentials: bashCredentials,
      }).run(fixture.context);
      await expect(fallback).resolves.toEqual({ exitCode: 0, signal: 0, coreDumped: false });
      expect(fixture.read("/workspace/gate/tree.result")).toBe("0:leaf\n");
      expect(fixture.stderr()).toBe("");
    } finally {
      await fixture.close();
    }
  });

  it("passes a generated 12-deep process tree, concurrent waits, and a 15-stage pipeline", async () => {
    const run = createBashGateway();
    const residentByteLimit = run.fixture.capacity.residentByteLimit;
    try {
      expect(run.fixture.capacity.limit).toBe(SLOT_COUNT);

      const nestedSource = [
        `printf '0:%s\\n' "$BASHPID" >> /workspace/gate/tree.processes`,
        ...Array.from({ length: NESTED_FORK_DEPTH }, (_, depth) => [
          `${"  ".repeat(depth)}(`,
          `${"  ".repeat(depth + 1)}printf '${depth + 1}:%s\\n' "$BASHPID" >> /workspace/gate/tree.processes`,
        ]).flat(),
        ...Array.from(
          { length: NESTED_FORK_DEPTH },
          (_, depth) => `${"  ".repeat(NESTED_FORK_DEPTH - depth - 1)})`,
        ),
      ].join("\n");
      const nested = await runBashScript(run.fixture, nestedSource);
      expect(nested).toEqual({
        stdout: "",
        stderr: "",
        status: { exitCode: 0, signal: 0, coreDumped: false },
      });
      const processRows = run.fixture
        .read("/workspace/gate/tree.processes")
        .trim()
        .split("\n")
        .map((line) => line.split(":"));
      expect(processRows).toHaveLength(NESTED_FORK_DEPTH + 1);
      expect(processRows.map(([depth]) => depth)).toEqual(
        Array.from({ length: NESTED_FORK_DEPTH + 1 }, (_, depth) => String(depth)),
      );
      expect(new Set(processRows.map(([, pid]) => pid)).size).toBe(NESTED_FORK_DEPTH + 1);
      await run.fixture.gateway.drain();
      expectBoundedSlots(run, residentByteLimit);

      for (const children of [15, 40]) {
        const wait = await runBashScript(
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
      const piped = await runBashScript(run.fixture, pipeline);
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
