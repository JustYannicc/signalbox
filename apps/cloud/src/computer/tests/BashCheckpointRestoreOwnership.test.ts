import { expect, it, vi } from "vite-plus/test";
import type { KernelBashForkSource, KernelBashForkState } from "../../kernel/KernelBashFork.ts";
import { createKernelBashReactor } from "../../kernel/KernelBashReactor.ts";
import type { KernelBashPort } from "../../kernel/KernelBashPort.ts";
import { withRpcReplyDisposer } from "./helpers/rpcReply.ts";

const captures: KernelBashForkState["captures"] = {
  stack: { low: 16, high: 2048, log: 1024 },
  base: 65_536,
  size: 16 << 20,
  names: [],
  stackNames: [],
  captures: [],
  top: 65_536,
  liveBytes: 0,
  nextId: 1,
  nextGeneration: 1,
};

function makeState(memoryBytes: number): KernelBashForkState {
  return {
    version: 1,
    memoryBytes,
    stackPointer: 1024,
    captures,
    continuation: {
      resume: 42,
      pending: {
        kind: "fork",
        role: "child",
        call: { namespace: "nimbus_proc", name: "fork", args: [] },
      },
    },
  };
}

function makeForkLandingModule() {
  const bytes = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  const unsigned = (value: number) => {
    const result: number[] = [];
    do {
      let byte = value & 0x7f;
      value >>>= 7;
      if (value !== 0) byte |= 0x80;
      result.push(byte);
    } while (value !== 0);
    return result;
  };
  const signed = (value: number) => {
    const result: number[] = [];
    for (;;) {
      let byte = value & 0x7f;
      value >>= 7;
      const done = (value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0);
      if (!done) byte |= 0x80;
      result.push(byte);
      if (done) return result;
    }
  };
  const name = (value: string) => {
    const encoded = [...new TextEncoder().encode(value)];
    return [...unsigned(encoded.length), ...encoded];
  };
  const section = (id: number, payload: readonly number[]) =>
    bytes.push(id, ...unsigned(payload.length), ...payload);

  section(1, [2, 0x60, 0, 1, 0x7f, 0x60, 0, 0]);
  section(2, [1, ...name("nimbus_proc"), ...name("fork"), 0, 0]);
  section(3, [6, 1, 0, 1, 1, 1, 1]);
  section(5, [1, 0, 1]);
  section(6, [
    3,
    0x7f,
    1,
    0x41,
    ...signed(1024),
    0x0b,
    0x7f,
    0,
    0x41,
    ...signed(16),
    0x0b,
    0x7f,
    0,
    0x41,
    ...signed(2048),
    0x0b,
  ]);
  const exports = [
    ["_start", 0, 1],
    ["nimbus_procenv_log", 0, 2],
    ["asyncify_start_unwind", 0, 3],
    ["asyncify_stop_unwind", 0, 4],
    ["asyncify_start_rewind", 0, 5],
    ["asyncify_stop_rewind", 0, 6],
    ["memory", 2, 0],
    ["__stack_pointer", 3, 0],
    ["__data_end", 3, 1],
    ["__heap_base", 3, 2],
  ];
  section(7, [
    exports.length,
    ...exports.flatMap(([exportName, kind, index]) => [
      ...name(String(exportName)),
      Number(kind),
      ...unsigned(Number(index)),
    ]),
  ]);
  const bodies = [
    [0, 0x10, 0, 0x1a, 0x0b],
    [0, 0x41, ...signed(1024), 0x0b],
    [0, 0x0b],
    [0, 0x0b],
    [0, 0x0b],
    [0, 0x0b],
  ];
  section(10, [bodies.length, ...bodies.flatMap((body) => [...unsigned(body.length), ...body])]);
  return new WebAssembly.Module(new Uint8Array(bytes));
}

function createReactor(
  source: KernelBashForkSource,
  bind: (instance: WebAssembly.Instance) => void,
) {
  const port = { complete: vi.fn(async () => {}) } as unknown as KernelBashPort;
  const reactor = createKernelBashReactor({
    module: makeForkLandingModule(),
    residentWasmBudgetBytes: 64 << 20,
    credentials: {
      uid: 1,
      gid: 1,
      euid: 1,
      egid: 1,
      umask: 0,
      hostname: "test",
    },
    pid: 7,
    port,
    snapshot: source,
    createBinding: () => ({
      imports: {},
      bind,
      async run(start) {
        if (typeof start !== "function") throw new TypeError("Bash start export is missing");
        (start as () => void)();
      },
    }),
  });
  return { port, reactor };
}

it("restores copied checkpoint bytes and continuation after disposing their replies", async () => {
  const stateReply = makeState(2048);
  const disposeState = vi.fn(() => {
    Object.assign(stateReply, { memoryBytes: 0 });
    Object.assign(stateReply.continuation, { resume: 999 });
    const pending = stateReply.continuation.pending;
    if (pending?.kind === "fork") Object.assign(pending, { role: "parent" });
  });
  const bytes = new Uint8Array(2048).fill(0x51);
  const disposeBytes = vi.fn(() => bytes.fill(0));
  const source: KernelBashForkSource = {
    state: async () => withRpcReplyDisposer(stateReply, disposeState),
    read: async () => withRpcReplyDisposer(bytes, disposeBytes),
    restored: vi.fn(async () => {}),
  };
  let instance: WebAssembly.Instance | undefined;
  const { reactor } = createReactor(source, (value) => (instance = value));

  await expect(reactor.run()).resolves.toEqual({ exitCode: 0, signal: 0, coreDumped: false });

  expect(disposeState).toHaveBeenCalledOnce();
  expect(disposeBytes).toHaveBeenCalledOnce();
  expect(source.restored).toHaveBeenCalledOnce();
  const memory = new Uint8Array((instance!.exports.memory as WebAssembly.Memory).buffer);
  expect(memory[200]).toBe(0x51);
});

it("disposes an unsupported checkpoint reply when public reactor restore fails", async () => {
  const reply = { ...makeState(0), version: 2 } as unknown as KernelBashForkState;
  const disposeReply = vi.fn(() => Object.assign(reply, { version: 1 }));
  const source: KernelBashForkSource = {
    state: async () => withRpcReplyDisposer(reply, disposeReply),
    read: vi.fn(async () => new Uint8Array()),
    restored: vi.fn(async () => {}),
  };
  const { port, reactor } = createReactor(source, () => {});

  await expect(reactor.run()).rejects.toThrow("Unsupported Bash checkpoint version 2");

  expect(disposeReply).toHaveBeenCalledOnce();
  expect(source.read).not.toHaveBeenCalled();
  expect(port.complete).toHaveBeenCalledWith(expect.objectContaining({ kind: "failure" }));
});

it("disposes checkpoint chunk replies when the public restore copy fails", async () => {
  const failure = new Error("checkpoint chunk copy failed");
  const stateReply = makeState(2048);
  const disposeState = vi.fn();
  const chunk = new Uint8Array(2048);
  Object.defineProperty(chunk, "slice", {
    value: () => {
      throw failure;
    },
  });
  const disposeChunk = vi.fn();
  const restored = vi.fn(async () => {});
  const source: KernelBashForkSource = {
    state: async () => withRpcReplyDisposer(stateReply, disposeState),
    read: async () => withRpcReplyDisposer(chunk, disposeChunk),
    restored,
  };
  const { reactor } = createReactor(source, () => {});

  await expect(reactor.run()).rejects.toBe(failure);

  expect(disposeState).toHaveBeenCalledOnce();
  expect(disposeChunk).toHaveBeenCalledOnce();
  expect(restored).not.toHaveBeenCalled();
});
