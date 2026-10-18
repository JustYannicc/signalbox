import { describe, expect, it } from "vite-plus/test";
import { AgentOsDescriptorHost } from "./AgentOsDescriptorHost.ts";
import { KernelFileSystem } from "./KernelFileSystem.ts";
import { createKernelAsyncWasi } from "./KernelWasi.ts";
import { KernelWakeRegistry } from "./KernelWakeRegistry.ts";
import { wasmImportReactor } from "./tests/wasmGuest.ts";

const NONBLOCK = 4;
const bytes = (text: string) => new TextEncoder().encode(text);

describe("WASI nonblocking stdio imports", () => {
  it("shares flags across pipe aliases and handles EAGAIN, readiness, blocking reads, and EOF", async () => {
    const filesystem = new KernelFileSystem({ mounts: [], stdio: [{}, {}, {}] });
    const wakes = new KernelWakeRegistry();
    const wasiRunners: WasiImportRunner[] = [];
    const pending: Promise<unknown>[] = [];

    try {
      const pipe = descriptorImportRunner(filesystem, wakes, "fd_pipe", ["i32", "i32"]);
      expect(pipe.run(64, 68)).toBe(0);
      const readFd = new DataView(pipe.memory.buffer).getUint32(64, true);
      const writeFd = new DataView(pipe.memory.buffer).getUint32(68, true);

      const duplicate = descriptorImportRunner(filesystem, wakes, "fd_dup", ["i32", "i32"]);
      expect(duplicate.run(readFd, 72)).toBe(0);
      const readAlias = new DataView(duplicate.memory.buffer).getUint32(72, true);

      const setFlags = await wasiRunner(filesystem, wakes, "fd_fdstat_set_flags", ["i32", "i32"]);
      wasiRunners.push(setFlags);
      const getFlags = await wasiRunner(filesystem, wakes, "fd_fdstat_get", ["i32", "i32"]);
      wasiRunners.push(getFlags);
      const read = await wasiRunner(filesystem, wakes, "fd_read", ["i32", "i32", "i32", "i32"]);
      wasiRunners.push(read);
      const write = await wasiRunner(filesystem, wakes, "fd_write", ["i32", "i32", "i32", "i32"]);
      wasiRunners.push(write);

      expect(await setFlags.run(readAlias, NONBLOCK)).toBe(0);
      expect(await getFlags.run(readFd, 64)).toBe(0);
      expect(new DataView(getFlags.memory.buffer).getUint16(66, true)).toBe(NONBLOCK);

      writeIovec(read.memory, 64, 128, 16);
      expect(await read.run(readFd, 64, 1, 80)).toBe(6);

      const firstData = bytes("ready");
      writeIovec(write.memory, 64, 128, firstData.byteLength, firstData);
      expect(await write.run(writeFd, 64, 1, 80)).toBe(0);
      expect(new DataView(write.memory.buffer).getUint32(80, true)).toBe(firstData.byteLength);
      expect(await read.run(readFd, 64, 1, 80)).toBe(0);
      expect(new DataView(read.memory.buffer).getUint32(80, true)).toBe(firstData.byteLength);
      expect(new Uint8Array(read.memory.buffer, 128, firstData.byteLength)).toEqual(firstData);

      const poll = await wasiRunner(filesystem, wakes, "poll_oneoff", ["i32", "i32", "i32", "i32"]);
      wasiRunners.push(poll);
      writePollSubscription(poll.memory, readFd);
      const pollWake = poll.run(0, 64, 1, 96);
      pending.push(pollWake);
      expect(wakes.size).toBe(1);
      const wakeData = bytes("wake");
      writeIovec(write.memory, 64, 128, wakeData.byteLength, wakeData);
      expect(await write.run(writeFd, 64, 1, 80)).toBe(0);
      expect(await pollWake).toBe(0);
      expect(readPollEvent(poll.memory)).toMatchObject({
        errno: 0,
        type: 1,
        bytes: 4n,
        hangup: false,
      });
      expect(wakes.size).toBe(0);
      expect(await read.run(readFd, 64, 1, 80)).toBe(0);
      expect(new Uint8Array(read.memory.buffer, 128, wakeData.byteLength)).toEqual(wakeData);

      expect(await setFlags.run(readAlias, 0)).toBe(0);
      expect(await getFlags.run(readFd, 64)).toBe(0);
      expect(new DataView(getFlags.memory.buffer).getUint16(66, true)).toBe(0);

      const blockingRead = read.run(readFd, 64, 1, 80);
      pending.push(blockingRead);
      expect(wakes.size).toBe(1);
      expect(await setFlags.run(readAlias, NONBLOCK)).toBe(0);
      expect(() => filesystem.read(readFd, new Uint8Array(1), null)).toThrow(
        expect.objectContaining({ code: "EAGAIN" }),
      );
      expect(wakes.size).toBe(1);
      const blockingData = bytes("blocking");
      writeIovec(write.memory, 64, 128, blockingData.byteLength, blockingData);
      expect(await write.run(writeFd, 64, 1, 80)).toBe(0);
      expect(await blockingRead).toBe(0);
      expect(new DataView(read.memory.buffer).getUint32(80, true)).toBe(blockingData.byteLength);
      expect(new Uint8Array(read.memory.buffer, 128, blockingData.byteLength)).toEqual(
        blockingData,
      );
      expect(await setFlags.run(readAlias, 0)).toBe(0);

      const close = await wasiRunner(filesystem, wakes, "fd_close", ["i32"]);
      wasiRunners.push(close);
      writePollSubscription(poll.memory, readFd);
      const pollEof = poll.run(0, 64, 1, 96);
      pending.push(pollEof);
      expect(wakes.size).toBe(1);
      expect(await close.run(writeFd)).toBe(0);
      expect(await pollEof).toBe(0);
      expect(readPollEvent(poll.memory)).toMatchObject({
        errno: 0,
        type: 1,
        bytes: 0n,
        hangup: true,
      });
      expect(await read.run(readFd, 64, 1, 80)).toBe(0);
      expect(new DataView(read.memory.buffer).getUint32(80, true)).toBe(0);
    } finally {
      wakes.dispose();
      await Promise.allSettled(pending);
      await Promise.allSettled(wasiRunners.map((runner) => runner.close()));
      filesystem.dispose();
    }
  });

  it("returns ENOTSUP when stdio has not opted into nonblocking callbacks", async () => {
    const filesystem = new KernelFileSystem({
      mounts: [],
      stdio: [{ readInto: () => 0 }, {}, {}],
    });
    const wakes = new KernelWakeRegistry();
    const runner = await wasiRunner(filesystem, wakes, "fd_fdstat_set_flags", ["i32", "i32"]);
    try {
      expect(await runner.run(0, NONBLOCK)).toBe(58);
    } finally {
      await runner.close();
      filesystem.dispose();
      wakes.dispose();
    }
  });
});

interface WasiImportRunner {
  readonly memory: WebAssembly.Memory;
  run(...args: Array<number | bigint>): Promise<number>;
  close(): Promise<void>;
}

async function wasiRunner(
  filesystem: KernelFileSystem,
  wakes: KernelWakeRegistry,
  importName: string,
  params: readonly ("i32" | "i64")[],
): Promise<WasiImportRunner> {
  const wasi = createKernelAsyncWasi({ filesystem, wakes });
  const instance = new WebAssembly.Instance(
    wasmImportReactor("wasi_snapshot_preview1", importName, params, ["i32"]),
    wasi.wasi.getImportObject(),
  );
  await wasi.wasi.initialize(instance);
  const run = instance.exports.run as (...args: Array<number | bigint>) => unknown;
  const memory = instance.exports.memory as WebAssembly.Memory;
  return {
    memory,
    run: (...args) => wasi.wasi.run(run, ...args) as Promise<number>,
    close: () => wasi.wasi.close(),
  };
}

function descriptorImportRunner(
  filesystem: KernelFileSystem,
  wakes: KernelWakeRegistry,
  importName: string,
  params: readonly ("i32" | "i64")[],
) {
  let instance: WebAssembly.Instance | undefined;
  const host = new AgentOsDescriptorHost({
    memory: () => {
      const memory = instance?.exports.memory;
      if (!(memory instanceof WebAssembly.Memory)) throw new Error("Guest memory is missing");
      return memory;
    },
    descriptors: filesystem.descriptors,
    wakes,
    asyncMode: true,
  });
  const hostProcessImports: Record<string, WebAssembly.ImportValue> =
    importName === "fd_pipe" ? { fd_pipe: host.imports.fd_pipe } : { fd_dup: host.imports.fd_dup };
  instance = new WebAssembly.Instance(
    wasmImportReactor("host_process", importName, params, ["i32"]),
    {
      host_process: hostProcessImports,
    },
  );
  const memory = instance.exports.memory as WebAssembly.Memory;
  const run = instance.exports.run as (...args: number[]) => number;
  return { memory, run: (...args: number[]) => run(...args) };
}

function writeIovec(
  memory: WebAssembly.Memory,
  iovecPointer: number,
  bufferPointer: number,
  length: number,
  contents?: Uint8Array,
): void {
  const view = new DataView(memory.buffer);
  view.setUint32(iovecPointer, bufferPointer, true);
  view.setUint32(iovecPointer + 4, length, true);
  if (contents !== undefined)
    new Uint8Array(memory.buffer, bufferPointer, contents.byteLength).set(contents);
}

function writePollSubscription(memory: WebAssembly.Memory, fd: number): void {
  const view = new DataView(memory.buffer);
  view.setBigUint64(0, 0xabcden, true);
  view.setUint8(8, 1);
  view.setUint32(16, fd, true);
}

function readPollEvent(memory: WebAssembly.Memory) {
  const event = new DataView(memory.buffer, 64, 32);
  return {
    errno: event.getUint16(8, true),
    type: event.getUint8(10),
    bytes: event.getBigUint64(16, true),
    hangup: event.getUint16(24, true) === 1,
  };
}
