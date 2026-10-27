import { describe, expect, it, vi } from "@effect/vitest";
import { KernelPipe } from "./KernelPipe.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { createKernelBashOperations } from "./KernelBashOperations.ts";
import type { KernelBashPort } from "./KernelBashPort.ts";
import { createKernelPollFixture } from "./tests/kernelPollFixture.ts";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => (resolve = done));
  return { promise, resolve };
}

const exitStatus = { exitCode: 0, signal: 0, coreDumped: false } as const;
const wasiResult = { kind: "return", value: 0, regions: [] } as const;
const bashResult = { value: 0, regions: [] } as const;
type MutablePort = {
  -readonly [Key in keyof Pick<KernelBashPort, "call" | "callBash" | "wait" | "exec">]: Pick<
    KernelBashPort,
    "call" | "callBash" | "wait" | "exec"
  >[Key];
};

function unusedPort(): MutablePort {
  const call: KernelBashPort["call"] = vi.fn(async () => wasiResult);
  const callBash: KernelBashPort["callBash"] = vi.fn(async () => bashResult);
  const wait: KernelBashPort["wait"] = vi.fn(async (pid: number, options: number) => ({
    kind: "wait" as const,
    pid: options === 0 ? pid : 0,
  }));
  const exec: KernelBashPort["exec"] = vi.fn(async () => ({
    kind: "exit" as const,
    status: exitStatus,
  }));
  return {
    call,
    callBash,
    wait,
    exec,
  };
}

describe("KernelBashOperations", () => {
  it("returns ready results for each immediate port operation exactly once", async () => {
    const port = unusedPort();
    const operations = createKernelBashOperations(port);
    const cases = [
      {
        operation: {
          kind: "wasi" as const,
          request: { name: "args_sizes_get", args: [0, 4], memorySize: 8, regions: [] },
        },
        expected: { kind: "wasi", value: wasiResult },
        method: port.call,
      },
      {
        operation: {
          kind: "bash" as const,
          request: {
            namespace: "nimbus_proc" as const,
            name: "identity",
            args: [0],
            memorySize: 8,
            regions: [],
          },
        },
        expected: { kind: "bash", value: bashResult },
        method: port.callBash,
      },
      {
        operation: { kind: "wait" as const, pid: 17, options: 1 },
        expected: { kind: "wait", value: { kind: "wait", pid: 0 } },
        method: port.wait,
      },
    ];

    for (const { operation, expected, method } of cases) {
      const started = await operations.start(operation);
      expect(readyResult(started)).toEqual(expected);
      expect(method).toHaveBeenCalledTimes(1);
    }
    await operations.close();
  });

  it("returns pending after a pipe write makes partial progress and takes its result once", async () => {
    const wakes = new KernelWakeRegistry();
    const pipe = new KernelPipe(wakes, 4096);
    const initial = new Uint8Array(2048).fill(0xaa);
    const source = Uint8Array.from({ length: 8192 }, (_, index) => index % 251);
    expect(pipe.tryWrite(initial)).toBe(initial.byteLength);
    const port = unusedPort();
    port.call = vi.fn(async () => {
      const value = await pipe.writeBlocking(source);
      return { kind: "return" as const, value, regions: [] };
    });
    const operations = createKernelBashOperations(port);

    const started = await operations.start({
      kind: "wasi",
      request: { name: "fd_write", args: [], memorySize: 0, regions: [] },
    });
    expect(started.kind).toBe("pending");
    if (started.kind !== "pending") throw new Error("Blocked write should be pending");
    expect(pipe.bufferedBytes).toBe(4096);

    const first = new Uint8Array(4096);
    expect(pipe.tryReadInto(first)).toBe(first.byteLength);
    expect(first.subarray(0, 2048)).toEqual(initial);
    expect(first.subarray(2048)).toEqual(source.subarray(0, 2048));

    const second = new Uint8Array(4096);
    await expect(pipe.readInto(second)).resolves.toBe(second.byteLength);
    expect(second).toEqual(source.subarray(2048, 6144));
    await expect(operations.take(started.id)).resolves.toEqual({
      kind: "wasi",
      value: { kind: "return", value: source.byteLength, regions: [] },
    });
    await expect(operations.take(started.id)).rejects.toThrow("Unknown or consumed Bash operation");
    expect(port.call).toHaveBeenCalledTimes(1);
    const remainder = new Uint8Array(2048);
    expect(pipe.tryReadInto(remainder)).toBe(remainder.byteLength);
    expect(remainder).toEqual(source.subarray(6144));
    await operations.close();
    wakes.dispose();
  });

  it("keeps a blocked wait owned until take and close both join it", async () => {
    const wakes = new KernelWakeRegistry();
    const finishWait = deferred<void>();
    const registered = wakes.register(() => () => {});
    if (registered.status !== "ok") throw new Error("Wake registration failed");
    const port = unusedPort();
    const exited = { exitCode: 3, signal: 0, coreDumped: false } as const;
    let closeFinished = false;
    port.wait = vi.fn(async (pid) => {
      const completion = await wakes.wait(registered.value);
      if (completion.status !== "ok") throw new Error(completion.error.message);
      await finishWait.promise;
      expect(closeFinished).toBe(false);
      return { kind: "wait" as const, pid, status: exited };
    });
    const operations = createKernelBashOperations(port);
    const started = await operations.start({ kind: "wait", pid: 23, options: 0 });
    expect(started.kind).toBe("pending");
    if (started.kind !== "pending") throw new Error("Blocked wait should be pending");

    const taken = operations.take(started.id);
    const closed = operations.close().then(() => {
      closeFinished = true;
    });
    expect(wakes.signal(registered.value)).toBe(true);
    finishWait.resolve();
    await expect(taken).resolves.toEqual({
      kind: "wait",
      value: { kind: "wait", pid: 23, status: exited },
    });
    await closed;
    expect(closeFinished).toBe(true);
    expect(port.wait).toHaveBeenCalledTimes(1);
    wakes.dispose();
  });

  it("keeps an immediately ready poll ready and counts no suspension", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const now = vi.spyOn(performance, "now").mockReturnValue(200);
    const fixture = createKernelPollFixture(100);
    const port = unusedPort();
    const call = vi.fn(fixture.call);
    port.call = call;
    const operations = createKernelBashOperations(port);
    try {
      const started = await operations.start({ kind: "wasi", request: fixture.request });
      const result = readyResult(started);
      expect(result.kind).toBe("wasi");
      if (result.kind !== "wasi") throw new Error("Poll should return a WASI result");
      expect(result.value).toMatchObject({ kind: "return", value: 0 });
      expect(fixture.eventCount(result.value)).toBe(1);
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      fixture.abort();
      await operations.close();
      fixture.close();
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it("returns pending for a clock poll and resumes at its explicit milestone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let nowMs = 100;
    const now = vi.spyOn(performance, "now").mockImplementation(() => nowMs);
    const fixture = createKernelPollFixture(200);
    const port = unusedPort();
    const call = vi.fn(fixture.call);
    port.call = call;
    const operations = createKernelBashOperations(port);
    const take = vi.spyOn(operations, "take");
    try {
      const started = await operations.start({ kind: "wasi", request: fixture.request });
      expect(started.kind).toBe("pending");
      if (started.kind !== "pending") throw new Error("Clock poll should be pending");
      expect(call).toHaveBeenCalledTimes(1);

      const resultPromise = take(started.id);
      nowMs = 200;
      await vi.advanceTimersByTimeAsync(100);
      const result = await resultPromise;
      expect(result.kind).toBe("wasi");
      if (result.kind !== "wasi") throw new Error("Poll should return a WASI result");
      expect(result.value).toMatchObject({ kind: "return", value: 0 });
      expect(fixture.eventCount(result.value)).toBe(1);
      expect(take).toHaveBeenCalledTimes(1);
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      fixture.abort();
      await operations.close();
      fixture.close();
      now.mockRestore();
      vi.useRealTimers();
    }
  });

  it("returns exec pending before child admission and preserves the single result", async () => {
    vi.useFakeTimers();
    const gate = deferred<{ kind: "exit"; status: typeof exitStatus }>();
    const port = unusedPort();
    port.exec = vi.fn(() => gate.promise);
    const operations = createKernelBashOperations(port);
    try {
      const started = await operations.start({
        kind: "exec",
        request: { path: "/bin/tool", args: ["tool"], env: {} },
      });
      expect(started.kind).toBe("pending");
      if (started.kind !== "pending") throw new Error("Exec must return pending");
      expect(port.exec).not.toHaveBeenCalled();

      const taking = operations.take(started.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(port.exec).toHaveBeenCalledTimes(1);
      gate.resolve({ kind: "exit", status: exitStatus });
      await expect(taking).resolves.toEqual({
        kind: "exec",
        value: { kind: "exit", status: exitStatus },
      });
    } finally {
      vi.useRealTimers();
      await operations.close();
    }
  });

  it("propagates a failure from take without creating an unhandled rejection", async () => {
    const failure = new Error("host operation failed");
    const wakes = new KernelWakeRegistry();
    const registered = wakes.register(() => () => {});
    if (registered.status !== "ok") throw new Error("Wake registration failed");
    const port = unusedPort();
    port.wait = vi.fn(async () => {
      await wakes.wait(registered.value);
      throw failure;
    });
    const operations = createKernelBashOperations(port);
    const started = await operations.start({ kind: "wait", pid: 1, options: 0 });
    expect(started.kind).toBe("pending");
    if (started.kind !== "pending") throw new Error("Wait should be pending");
    const taking = operations.take(started.id);
    wakes.signal(registered.value);
    await expect(taking).rejects.toBe(failure);
    await operations.close();
    wakes.dispose();
  });
});

type Started = Awaited<ReturnType<ReturnType<typeof createKernelBashOperations>["start"]>>;

function readyResult(started: Started) {
  if (started.kind !== "ready") throw new Error("Operation should be ready");
  return started.result;
}
