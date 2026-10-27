import { describe, expect, it, vi } from "vite-plus/test";
import { createKernelBashOperations } from "./KernelBashOperations.ts";
import type { KernelBashOperation } from "./KernelBashCheckpoint.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";

const status = { exitCode: 7, signal: 0, coreDumped: false };
const cases: readonly KernelBashOperation[] = [
  { kind: "wasi", request: { name: "fd_read", args: [], memorySize: 8, regions: [] } },
  {
    kind: "bash",
    request: { namespace: "nimbus_proc", name: "identity", args: [], memorySize: 8, regions: [] },
  },
  { kind: "wait", pid: 17, options: 0 },
  { kind: "exec", request: { path: "/bin/tool", args: ["tool"], env: {} } },
];

function owned<Value extends object>(value: Value) {
  const dispose = vi.fn();
  return { reply: Object.assign(value, { [Symbol.dispose]: dispose }), dispose };
}

function fixture(failRead = false) {
  const replies = {
    wasi: owned({ kind: "return" as const, value: 3, regions: [] }),
    bash: owned({ value: 3, regions: [] }),
    wait: owned({ kind: "wait" as const, pid: 17, status }),
    exec: owned({ kind: "exit" as const, status }),
  };
  if (failRead) {
    for (const received of Object.values(replies)) {
      Object.defineProperty(received.reply, Object.keys(received.reply)[0]!, {
        enumerable: true,
        get() {
          throw new Error("reply decode failed");
        },
      });
    }
  }
  const operations = createKernelBashOperations({
    call: async () => replies.wasi.reply,
    callBash: async () => replies.bash.reply,
    wait: async () => replies.wait.reply,
    exec: async () => replies.exec.reply,
  });
  return { operations, replies };
}

describe("Bash host operation RPC replies", () => {
  it("keeps bounded byte regions when releasing a reply record", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { reply, dispose } = owned({
      kind: "return" as const,
      value: 3,
      regions: [{ pointer: 0, bytes }],
    });
    const operations = createKernelBashOperations({
      call: async () => reply,
      callBash: async () => ({ value: 0, regions: [] }),
      wait: async () => ({ kind: "wait", pid: 0 }),
      exec: async () => ({ kind: "exit", status }),
    });
    try {
      const started = await operations.start(cases[0]!);
      if (
        started.kind !== "ready" ||
        started.result.kind !== "wasi" ||
        started.result.value.kind !== "return"
      )
        throw new Error("Expected ready WASI data");
      expect(started.result.value.regions[0]!.bytes).toBe(bytes);
      expect([...bytes]).toEqual([1, 2, 3]);
      expect(dispose).toHaveBeenCalledOnce();
      expect(Symbol.dispose in started.result.value).toBe(false);
    } finally {
      await operations.close();
    }
  });

  it.each(cases)("consumes the $kind result before storing plain data", async (operation) => {
    vi.useFakeTimers();
    const { operations, replies } = fixture();
    try {
      const started = await operations.start(operation);
      const taking =
        started.kind === "ready" ? Promise.resolve(started.result) : operations.take(started.id);
      await vi.runAllTimersAsync();
      const result = await taking;
      expect(result.kind).toBe(operation.kind);
      const expected = {
        wasi: { kind: "return", value: 3, regions: [] },
        bash: { value: 3, regions: [] },
        wait: { kind: "wait", pid: 17, status },
        exec: { kind: "exit", status },
      };
      expect(result.value).toEqual(expected[operation.kind]);
      expect(Symbol.dispose in result.value).toBe(false);
      expect(replies[operation.kind].dispose).toHaveBeenCalledOnce();
    } finally {
      await operations.close();
      vi.useRealTimers();
    }
  });

  it.each(cases)(
    "consumes the $kind result when its data cannot be retained",
    async (operation) => {
      vi.useFakeTimers();
      const { operations, replies } = fixture(true);
      try {
        const started = operations.start(operation);
        if (operation.kind === "exec") {
          const pending = await started;
          if (pending.kind !== "pending") throw new Error("Exec must return pending");
          const taken = operations.take(pending.id);
          const failed = taken.then(
            () => undefined,
            (error: unknown) => error,
          );
          await vi.runAllTimersAsync();
          expect(await failed).toMatchObject({ message: "reply decode failed" });
        } else {
          const failure = await started.then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(failure).toMatchObject({ message: "reply decode failed" });
        }
        expect(replies[operation.kind].dispose).toHaveBeenCalledOnce();
      } finally {
        await operations.close();
        vi.useRealTimers();
      }
    },
  );

  it("releases a blocked reply when close joins the abandoned operation", async () => {
    const wakes = new KernelWakeRegistry();
    const registered = wakes.register(() => () => {});
    if (registered.status !== "ok") throw new Error("Wake registration failed");
    const { reply, dispose } = owned({ kind: "wait" as const, pid: 17, status });
    const operations = createKernelBashOperations({
      call: async () => ({ kind: "return", value: 0, regions: [] }),
      callBash: async () => ({ value: 0, regions: [] }),
      exec: async () => ({ kind: "exit", status }),
      async wait() {
        await wakes.wait(registered.value);
        return reply;
      },
    });
    try {
      expect(await operations.start({ kind: "wait", pid: 17, options: 0 })).toMatchObject({
        kind: "pending",
      });
      const closing = operations.close();
      wakes.signal(registered.value);
      await closing;
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      await operations.close();
      wakes.dispose();
    }
  });
});
