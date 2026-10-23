import { expect, it, vi } from "vite-plus/test";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { kernelPayloadBudget } from "./KernelPayloadBudget.ts";
import { createKernelSyscallHost } from "./KernelSyscallHost.ts";

function writeRequest(offset: number, transferLength: number, syscallLength = transferLength) {
  const table = new Uint8Array(8);
  new DataView(table.buffer).setUint32(0, 128, true);
  new DataView(table.buffer).setUint32(4, syscallLength, true);
  return {
    name: "fd_write",
    args: [1, 0, 1, 16],
    memorySize: 128 + Math.max(syscallLength, offset + transferLength),
    regions: [
      { pointer: 0, direction: "in" as const, bytes: table },
      { pointer: 16, direction: "out" as const, length: 4, bytes: new Uint8Array() },
      {
        pointer: 128 + offset,
        direction: "in" as const,
        bytes: new Uint8Array(transferLength),
      },
    ],
    transferOffset: offset,
    transferLength,
  };
}

function readRequest(offset: number, transferLength: number, syscallLength = transferLength) {
  const table = new Uint8Array(8);
  new DataView(table.buffer).setUint32(0, 128, true);
  new DataView(table.buffer).setUint32(4, syscallLength, true);
  return {
    name: "fd_read",
    args: [0, 0, 1, 16],
    memorySize: 128 + Math.max(syscallLength, offset + transferLength),
    regions: [
      { pointer: 0, direction: "in" as const, bytes: table },
      { pointer: 16, direction: "out" as const, length: 4, bytes: new Uint8Array() },
      {
        pointer: 128 + offset,
        direction: "out" as const,
        length: transferLength,
        bytes: new Uint8Array(),
      },
    ],
    transferOffset: offset,
    transferLength,
  };
}

it("preserves the exact legacy response shape for a port without transfer continuations", async () => {
  const filesystem = new KernelFileSystem({ mounts: [], stdio: [{}, {}, {}] });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  try {
    expect(await host.call({ name: "fd_close", args: [0], memorySize: 0, regions: [] })).toEqual({
      kind: "return",
      value: 0,
      regions: [],
    });
  } finally {
    host.close();
    filesystem.dispose();
  }
});

it("adapts to complete small writes without losing the window on non-I/O calls", async () => {
  const filesystem = new KernelFileSystem({
    mounts: [],
    stdio: [{}, { write: (source) => source.byteLength }, {}],
  });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  try {
    const initial = await host.call({
      name: "sched_yield",
      args: [],
      memorySize: 0,
      regions: [],
      transferOffset: 0,
    });
    const firstWrite = await host.call(writeRequest(0, 64 * 1024));
    const secondWrite = await host.call(writeRequest(0, 128 * 1024));
    const betweenWrites = await host.call({
      name: "sched_yield",
      args: [],
      memorySize: 0,
      regions: [],
      transferOffset: 0,
    });
    const smallWrite = await host.call(writeRequest(0, 4096));

    expect(initial.kind).toBe("return");
    expect(firstWrite).toMatchObject({ kind: "return", value: 0 });
    expect(betweenWrites.kind).toBe("return");
    expect(secondWrite).toMatchObject({ kind: "return", value: 0 });
    expect(smallWrite).toMatchObject({ kind: "return", value: 0 });
    if (
      initial.kind !== "return" ||
      firstWrite.kind !== "return" ||
      betweenWrites.kind !== "return" ||
      secondWrite.kind !== "return" ||
      smallWrite.kind !== "return"
    )
      return;
    expect(firstWrite.transferWindow).toBeGreaterThan(initial.transferWindow ?? 0);
    expect(secondWrite.transferWindow).toBeGreaterThan(firstWrite.transferWindow ?? 0);
    expect(betweenWrites.transferWindow).toBe(secondWrite.transferWindow);
    expect(smallWrite.transferWindow).toBe(Math.floor((betweenWrites.transferWindow ?? 0) / 2));
  } finally {
    host.close();
    filesystem.dispose();
  }
});

it("uses the complete guest syscall amount when adapting across continuations", async () => {
  const filesystem = new KernelFileSystem({
    mounts: [],
    stdio: [{}, { write: (source) => source.byteLength }, {}],
  });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  try {
    const initial = await host.call({
      name: "sched_yield",
      args: [],
      memorySize: 0,
      regions: [],
      transferOffset: 0,
    });
    const firstChunk = await host.call(writeRequest(0, 64 * 1024, 96 * 1024));
    const finalChunk = await host.call(writeRequest(64 * 1024, 32 * 1024, 96 * 1024));

    expect(initial.kind).toBe("return");
    expect(firstChunk).toMatchObject({ kind: "return", value: 0 });
    expect(finalChunk).toMatchObject({ kind: "return", value: 0 });
    if (initial.kind !== "return" || firstChunk.kind !== "return" || finalChunk.kind !== "return")
      return;
    expect(firstChunk.transferWindow).toBe(initial.transferWindow);
    expect(finalChunk.transferWindow).toBeGreaterThan(initial.transferWindow ?? 0);
  } finally {
    host.close();
    filesystem.dispose();
  }
});

it("keeps read tuning across small writes and treats drained stream batches as full", async () => {
  let reads = 0;
  const filesystem = new KernelFileSystem({
    mounts: [],
    stdio: [
      {
        readInto(target) {
          const count = reads++ === 0 ? 32 * 1024 : target.byteLength;
          target.fill(1, 0, count);
          return count;
        },
      },
      { write: (source) => source.byteLength },
      {},
    ],
  });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  try {
    const initial = await host.call({
      name: "sched_yield",
      args: [],
      memorySize: 0,
      regions: [],
      transferOffset: 0,
    });
    const shortStreamRead = await host.call(readRequest(0, 64 * 1024, 128 * 1024));
    const fullRead = await host.call(readRequest(0, 128 * 1024));
    const smallWrite = await host.call(writeRequest(0, 4096));
    const tinyRead = await host.call(readRequest(0, 4096));

    expect(initial.kind).toBe("return");
    expect(shortStreamRead).toMatchObject({ kind: "return", value: 0 });
    expect(fullRead).toMatchObject({ kind: "return", value: 0 });
    expect(smallWrite).toMatchObject({ kind: "return", value: 0 });
    expect(tinyRead).toMatchObject({ kind: "return", value: 0 });
    if (
      initial.kind !== "return" ||
      shortStreamRead.kind !== "return" ||
      fullRead.kind !== "return" ||
      smallWrite.kind !== "return" ||
      tinyRead.kind !== "return"
    )
      return;
    expect(shortStreamRead.transferWindow).toBeGreaterThan(initial.transferWindow ?? 0);
    expect(fullRead.transferWindow).toBeGreaterThan(shortStreamRead.transferWindow ?? 0);
    expect(smallWrite.transferWindow).toBe(fullRead.transferWindow);
    expect(tinyRead.transferWindow).toBe(Math.floor((fullRead.transferWindow ?? 0) / 2));
  } finally {
    host.close();
    filesystem.dispose();
  }
});

it("returns the in-flight credit when a call settles after an idempotent close", async () => {
  const entered = Promise.withResolvers<void>();
  const read = Promise.withResolvers<number>();
  const filesystem = new KernelFileSystem({
    mounts: [],
    stdio: [
      {
        readInto: () => {
          entered.resolve();
          return read.promise;
        },
      },
      {},
      {},
    ],
  });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  let outstanding = 0;
  const open = kernelPayloadBudget.open.bind(kernelPayloadBudget);
  const spy = vi.spyOn(kernelPayloadBudget, "open").mockImplementation(async (...args) => {
    const window = await open(...args);
    outstanding++;
    let released = false;
    return {
      ...window,
      release() {
        if (!released) {
          released = true;
          outstanding--;
        }
        window.release();
      },
    };
  });
  const table = new Uint8Array(8);
  new DataView(table.buffer).setUint32(0, 128, true);
  new DataView(table.buffer).setUint32(4, 1024, true);
  let running: ReturnType<typeof host.call> | undefined;
  try {
    await host.call({
      name: "sched_yield",
      args: [],
      memorySize: 0,
      regions: [],
      transferOffset: 0,
    });
    expect(outstanding).toBe(1);
    running = host.call({
      name: "fd_read",
      args: [0, 0, 1, 16],
      memorySize: 2048,
      regions: [
        { pointer: 0, direction: "in", bytes: table },
        { pointer: 16, direction: "out", length: 4, bytes: new Uint8Array() },
        { pointer: 128, direction: "out", length: 1024, bytes: new Uint8Array() },
      ],
      transferOffset: 0,
    });
    await entered.promise;
    expect(() => {
      host.close();
      host.close();
    }).not.toThrow();
    expect(outstanding).toBe(1);
    read.resolve(0);
    await running;
    expect(outstanding).toBe(0);
  } finally {
    read.resolve(0);
    await running;
    host.close();
    spy.mockRestore();
    filesystem.dispose();
  }
});

it("honors a smaller child prefix after a larger credit was granted", async () => {
  let accepted = 0;
  const filesystem = new KernelFileSystem({
    mounts: [],
    stdio: [
      {},
      {
        write(source) {
          accepted += source.byteLength;
          return source.byteLength;
        },
      },
      {},
    ],
  });
  const host = createKernelSyscallHost({
    filesystem,
    args: [],
    env: {},
    signal: new AbortController().signal,
  });
  const table = new Uint8Array(8);
  new DataView(table.buffer).setUint32(0, 128, true);
  new DataView(table.buffer).setUint32(4, 8192, true);
  try {
    const warm = await host.call({
      name: "sched_yield",
      args: [],
      memorySize: 0,
      regions: [],
      transferOffset: 0,
    });
    expect(warm.kind).toBe("return");
    if (warm.kind === "return") expect(warm.transferWindow).toBeGreaterThan(4096);
    expect(
      await host.call({
        name: "fd_write",
        args: [1, 0, 1, 16],
        memorySize: 16384,
        regions: [
          { pointer: 0, direction: "in", bytes: table },
          { pointer: 16, direction: "out", length: 4, bytes: new Uint8Array() },
          { pointer: 128, direction: "in", bytes: new Uint8Array(4096) },
        ],
        transferOffset: 0,
        transferLength: 4096,
      }),
    ).toMatchObject({ kind: "return", value: 0 });
    expect(accepted).toBe(4096);
  } finally {
    host.close();
    filesystem.dispose();
  }
});
