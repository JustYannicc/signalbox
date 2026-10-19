import { describe, expect, it } from "vite-plus/test";
import { createHookService } from "../HookService.ts";

const encoder = new TextEncoder();
const refusal = encoder.encode("A person must approve this command.\n");
const output = encoder.encode('{"decision":"block"}\n');
const exit = { exitCode: 2, signal: 0, coreDumped: false };
const unreadable = async (): Promise<never> => {
  throw new Error("Wrong hook route");
};
const bytes = (value: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(value);
      stream.close();
    },
  });

function setup(failure: Error, phase: "write" | "close") {
  let disposals = 0;
  const service = createHookService({
    registrations: new Map([
      [
        "refuse",
        {
          harness: "codex",
          event: "pre-tool-use",
          sessionId: "session",
          kind: "command",
          command: { executable: "/bin/bash", argv: ["bash", "-c", "exit 2"] },
        },
      ],
    ]),
    commands: {
      exec: async () => ({
        stdin: new WritableStream({
          [phase]: () => {
            throw failure;
          },
        }),
        stdout: bytes(output),
        stderr: bytes(refusal),
        exited: Promise.resolve(exit),
        signal: unreadable,
        dispose: async () => {
          disposals++;
        },
      }),
    },
    generated: { invoke: unreadable },
    capacity: { tryAcquire: () => ({ release() {} }) },
  });
  return {
    run: () =>
      service.invoke(
        "refuse",
        { tool_input: "a".repeat(100_000) },
        {
          cwd: "/work",
          env: {},
          signal: new AbortController().signal,
        },
      ),
    disposals: () => disposals,
  };
}

describe("command hook closing stdin before consuming its payload", () => {
  it.each(["write", "close"] as const)(
    "retains native blocking status and output after %s EPIPE",
    async (phase) => {
      const failure = Object.assign(new Error("Pipe has no reader"), { code: "EPIPE" });
      const test = setup(failure, phase);
      expect(await test.run()).toEqual({ stdout: output, stderr: refusal, exit });
      expect(test.disposals()).toBe(1);
    },
  );

  it("retains failures other than the child closing its input pipe", async () => {
    const failure = Object.assign(new Error("Storage unavailable"), { code: "EIO" });
    const test = setup(failure, "write");
    await expect(test.run()).rejects.toBe(failure);
    expect(test.disposals()).toBe(1);
  });
});
