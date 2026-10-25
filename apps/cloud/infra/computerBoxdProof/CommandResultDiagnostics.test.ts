import { describe, expect, it } from "vite-plus/test";
import type {
  KernelCommandChild,
  KernelCommandExit,
} from "../../src/kernel/KernelCommandForwarder.ts";
import { EXPECTED_STDOUT, runProofCommand } from "./Command.ts";
import type { ProofCommandResultDiagnostics } from "./Command.ts";

const EXPECTED_STDERR = new Uint8Array([128, 0]);
const EXPECTED_STDIN = new TextEncoder().encode("input 雪\n");
const EXPECTED_DIAGNOSTICS: ProofCommandResultDiagnostics = {
  stdoutBytesMatch: true,
  stderrBytesMatch: true,
  exitCode17: true,
  signalZero: true,
  coreDumpedFalse: true,
};

function readable(chunks: readonly Uint8Array[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk.slice());
      controller.close();
    },
  });
}

function commandChild(input: {
  readonly stdout?: readonly Uint8Array[];
  readonly stderr?: readonly Uint8Array[];
  readonly exit?: KernelCommandExit;
}) {
  const stdin: Uint8Array[] = [];
  let disposeCalls = 0;
  const child: KernelCommandChild = {
    stdin: new WritableStream<Uint8Array>({
      write(bytes) {
        stdin.push(bytes.slice());
      },
    }),
    stdout: readable(input.stdout ?? [EXPECTED_STDOUT]),
    stderr: readable(input.stderr ?? [EXPECTED_STDERR]),
    exited: Promise.resolve(input.exit ?? { exitCode: 17, signal: 0, coreDumped: false }),
    signal: async () => ({ status: "ok", value: undefined }),
    dispose: async () => {
      disposeCalls++;
    },
  };
  return {
    child,
    stdin,
    disposeCalls: () => disposeCalls,
  };
}

describe("proof command result diagnostics", () => {
  it("keeps the no-reporter command behavior and disposes the child", async () => {
    const controlled = commandChild({
      stdout: [EXPECTED_STDOUT.slice(0, 2), EXPECTED_STDOUT.slice(2)],
      stderr: [EXPECTED_STDERR.slice(0, 1), EXPECTED_STDERR.slice(1)],
    });

    const result = await runProofCommand(controlled.child);

    expect(result.stdout).toEqual(EXPECTED_STDOUT);
    expect(result.stderr).toEqual(EXPECTED_STDERR);
    expect(result.exit).toEqual({ exitCode: 17, signal: 0, coreDumped: false });
    expect(controlled.stdin).toEqual([EXPECTED_STDIN]);
    expect(controlled.disposeCalls()).toBe(1);
  });

  it("keeps the existing mismatch rejection when no reporter is supplied", async () => {
    const controlled = commandChild({
      stdout: [new TextEncoder().encode("private stdout")],
    });

    await expect(runProofCommand(controlled.child)).rejects.toThrow(
      "Proof command changed argv0, cwd, env, binary streams, stdin or exit status",
    );
    expect(controlled.disposeCalls()).toBe(1);
  });

  it("reports only fixed field matches for successful command output", async () => {
    const controlled = commandChild({
      stdout: [EXPECTED_STDOUT.slice(0, 2), EXPECTED_STDOUT.slice(2)],
      stderr: [EXPECTED_STDERR.slice(0, 1), EXPECTED_STDERR.slice(1)],
    });
    const reports: ProofCommandResultDiagnostics[] = [];

    await runProofCommand(controlled.child, async (diagnostics) => {
      reports.push(diagnostics);
    });

    expect(reports).toEqual([EXPECTED_DIAGNOSTICS]);
    expect(JSON.stringify(reports)).not.toContain("input");
    expect(controlled.disposeCalls()).toBe(1);
  });

  it("reports each mismatched result field while keeping the command rejection", async () => {
    const cases: readonly {
      readonly field: keyof ProofCommandResultDiagnostics;
      readonly child: ReturnType<typeof commandChild>;
    }[] = [
      {
        field: "stdoutBytesMatch",
        child: commandChild({ stdout: [new TextEncoder().encode("private stdout")] }),
      },
      {
        field: "stderrBytesMatch",
        child: commandChild({ stderr: [new TextEncoder().encode("private stderr")] }),
      },
      {
        field: "exitCode17",
        child: commandChild({ exit: { exitCode: 18, signal: 0, coreDumped: false } }),
      },
      {
        field: "signalZero",
        child: commandChild({ exit: { exitCode: 17, signal: 9, coreDumped: false } }),
      },
      {
        field: "coreDumpedFalse",
        child: commandChild({ exit: { exitCode: 17, signal: 0, coreDumped: true } }),
      },
    ];

    for (const { field, child: controlled } of cases) {
      const reports: ProofCommandResultDiagnostics[] = [];
      const result = runProofCommand(controlled.child, async (diagnostics) => {
        reports.push(diagnostics);
      });

      await expect(result).rejects.toThrow(
        "Proof command changed argv0, cwd, env, binary streams, stdin or exit status",
      );
      const expected = { ...EXPECTED_DIAGNOSTICS, [field]: false };
      expect(reports).toEqual([expected]);
      expect(JSON.stringify(reports)).not.toContain("private");
      expect(controlled.disposeCalls()).toBe(1);
    }
  });

  it("preserves a command failure when its failed diagnostic write rejects", async () => {
    const controlled = commandChild({ stdout: [new TextEncoder().encode("private stdout")] });
    const reportError = new Error("private report store detail");

    await expect(
      runProofCommand(controlled.child, async () => {
        throw reportError;
      }),
    ).rejects.toThrow(
      "Proof command changed argv0, cwd, env, binary streams, stdin or exit status",
    );
    expect(controlled.disposeCalls()).toBe(1);
  });
});
