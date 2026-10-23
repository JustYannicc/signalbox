import { describe, expect, it } from "vite-plus/test";
import type { KernelBashCheckpointContinuation } from "../../kernel/KernelBashCheckpoint.ts";
import { KernelProcessSignal } from "../../kernel/KernelProcessSignal.ts";
import {
  KERNEL_SYSCALL_MAX_IO_BYTES,
  type KernelSyscallRequest,
  type KernelSyscallResponse,
} from "../../kernel/KernelSyscallPort.ts";
import { createChildWasi } from "../ChildWasi.ts";
import { applyChildWasiIoWindow, childWasiIo, childWasiIoWindow } from "../ChildWasiIo.ts";
import { wasmImportReactor } from "./CoreutilsWasmImportFixture.ts";

const WINDOW = KERNEL_SYSCALL_MAX_IO_BYTES;

describe("child WASI I/O continuations", () => {
  it("resumes a cloned checkpoint after transfer when the iovec table, read buffer, and count overlap", () => {
    const memory = createMemory(WINDOW + 256);
    const tablePointer = 64;
    const bufferPointer = tablePointer;
    const countPointer = tablePointer + 4;
    const length = WINDOW + 10;
    const view = new DataView(memory.buffer);
    view.setUint32(tablePointer, bufferPointer, true);
    view.setUint32(tablePointer + 4, length, true);

    const firstRequest = childWasiIoWindow({
      name: "fd_read",
      args: [0, tablePointer, 1, countPointer],
      memory,
    });
    if (firstRequest === undefined) throw new Error("Expected a read window");

    const restoredFirst = cloneAfterTransfer(firstRequest, "fd_read");
    const first = applyChildWasiIoWindow({
      request: restoredFirst,
      response: readResponse(bufferPointer, WINDOW, countPointer, WINDOW),
      memory,
    });
    expect(first?.kind).toBe("continue");
    if (first?.kind !== "continue") throw new Error("Expected a resumed read window");
    expect(first.request.transferOffset).toBe(WINDOW);
    expect(first.request.regions.map((region) => region.pointer)).toContain(bufferPointer + WINDOW);

    const restoredSecond = cloneAfterTransfer(first.request, "fd_read");
    const second = applyChildWasiIoWindow({
      request: restoredSecond,
      response: readResponse(bufferPointer + WINDOW, 10, countPointer, 10),
      memory,
    });
    expect(second).toEqual({ kind: "complete", value: 0 });
    expect(new DataView(memory.buffer).getUint32(countPointer, true)).toBe(length);
  });

  it("keeps an overlapping path_readlink input intact across a detached window", () => {
    const memory = createMemory(WINDOW * 2 + 256);
    const pathPointer = 64;
    const path = new TextEncoder().encode("link");
    const countPointer = WINDOW * 2 + 64;
    new Uint8Array(memory.buffer, pathPointer, path.byteLength).set(path);

    const request = childWasiIoWindow({
      name: "path_readlink",
      args: [3, pathPointer, path.byteLength, pathPointer, WINDOW + 1, countPointer],
      memory,
    });
    if (request === undefined) throw new Error("Expected a readlink window");

    const restored = cloneAfterTransfer(request, "path_readlink");
    const progress = applyChildWasiIoWindow({
      request: restored,
      response: readResponse(pathPointer, WINDOW, countPointer, WINDOW),
      memory,
    });
    expect(progress?.kind).toBe("continue");
    if (progress?.kind !== "continue") throw new Error("Expected a resumed readlink window");

    const pathRegion = progress.request.regions.find((region) => region.pointer === pathPointer);
    expect(pathRegion?.bytes.subarray(0, path.byteLength)).toEqual(path);
  });

  it.each([
    ["signal", { kind: "signal", signal: 9 }],
    ["exit", { kind: "exit", code: 23 }],
  ] as const)("preserves a later-window %s through ChildWasi.applyOperation", (_name, terminal) => {
    const { child, memory } = createBoundChild(WINDOW + 2048);
    const tablePointer = 64;
    const bufferPointer = 1024;
    const countPointer = 16;
    const view = new DataView(memory.buffer);
    view.setUint32(tablePointer, bufferPointer, true);
    view.setUint32(tablePointer + 4, WINDOW + 10, true);

    const firstRequest = childWasiIoWindow({
      name: "fd_read",
      args: [0, tablePointer, 1, countPointer],
      memory,
    });
    if (firstRequest === undefined) throw new Error("Expected a read window");
    const first = applyChildWasiIoWindow({
      request: firstRequest,
      response: readResponse(bufferPointer, WINDOW, countPointer, WINDOW),
      memory,
    });
    expect(first?.kind).toBe("continue");
    if (first?.kind !== "continue") throw new Error("Expected a resumed read window");

    const effect = () =>
      child.applyOperation(
        { kind: "wasi", request: first.request },
        {
          namespace: "wasi_snapshot_preview1",
          name: "fd_read",
          args: [0, tablePointer, 1, countPointer],
        },
        { kind: "wasi", value: terminal },
      );

    if (terminal.kind === "signal") {
      let failure: unknown;
      try {
        effect();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(KernelProcessSignal);
      expect((failure as KernelProcessSignal).signal).toBe(terminal.signal);
    } else {
      expect(effect()).toEqual({
        kind: "exit",
        status: { exitCode: terminal.code, signal: 0, coreDumped: false },
      });
    }
  });

  it.each([
    ["process signal", new KernelProcessSignal(9)],
    ["unknown error", new Error("later syscall failed")],
  ] as const)("propagates a thrown %s after partial progress", async (_name, failure) => {
    const memory = createMemory(WINDOW + 2048);
    const tablePointer = 64;
    const bufferPointer = 1024;
    const countPointer = 16;
    const view = new DataView(memory.buffer);
    view.setUint32(tablePointer, bufferPointer, true);
    view.setUint32(tablePointer + 4, WINDOW + 10, true);
    let calls = 0;

    const result = childWasiIo({
      name: "fd_write",
      args: [1, tablePointer, 1, countPointer],
      memory,
      syscalls: {
        async call() {
          if (calls++ > 0) throw failure;
          return {
            kind: "return",
            value: 0,
            regions: [u32Region(countPointer, WINDOW)],
            io: { descriptor: "file", nonblocking: false },
          };
        },
      },
    });

    await expect(result).rejects.toBe(failure);
  });
});

function createMemory(requiredBytes: number): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: Math.ceil(requiredBytes / 65_536) });
}

function createBoundChild(requiredBytes: number) {
  const module = wasmImportReactor(
    "wasi_snapshot_preview1",
    "fd_read",
    ["i32", "i32", "i32", "i32"],
    ["i32"],
  );
  const child = createChildWasi({
    module,
    args: [],
    env: {},
    syscalls: {
      async call() {
        throw new Error("The test only applies a saved operation");
      },
    },
  });
  const instance = new WebAssembly.Instance(module, child.imports);
  child.bind(instance);
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("Expected WASI memory");
  const pages = Math.ceil(Math.max(0, requiredBytes - memory.buffer.byteLength) / 65_536);
  if (pages > 0) memory.grow(pages);
  return { child, memory };
}

function readResponse(
  outputPointer: number,
  outputLength: number,
  countPointer: number,
  count: number,
): KernelSyscallResponse {
  const output = new Uint8Array(outputLength).fill(0x5a);
  if (countPointer >= outputPointer && countPointer + 4 <= outputPointer + outputLength) {
    new DataView(output.buffer).setUint32(countPointer - outputPointer, count, true);
    return {
      kind: "return",
      value: 0,
      regions: [{ pointer: outputPointer, bytes: output }],
      io: { descriptor: "file", nonblocking: false },
    };
  }

  return {
    kind: "return",
    value: 0,
    regions: [u32Region(countPointer, count), { pointer: outputPointer, bytes: output }].sort(
      (left, right) => left.pointer - right.pointer,
    ),
    io: { descriptor: "file", nonblocking: false },
  };
}

function u32Region(pointer: number, value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return { pointer, bytes };
}

function cloneAfterTransfer(request: KernelSyscallRequest, name: string): KernelSyscallRequest {
  const checkpoint: KernelBashCheckpointContinuation = {
    resume: 1,
    pending: {
      kind: "operation",
      operation: { kind: "wasi", request },
      call: {
        namespace: "wasi_snapshot_preview1",
        name,
        args: request.args,
      },
    },
  };
  const restored = structuredClone(checkpoint);
  const pending = restored.pending;
  if (pending?.kind !== "operation" || pending.operation.kind !== "wasi") {
    throw new Error("Expected a restored WASI checkpoint operation");
  }
  const restoredRequest = pending.operation.request;
  const transfer = [...new Set(restoredRequest.regions.map((region) => region.bytes.buffer))];
  structuredClone(restoredRequest, { transfer });
  if (!restoredRequest.regions.some((region) => region.bytes.byteLength === 0)) {
    throw new Error("Expected the transferred request regions to detach");
  }
  return restoredRequest;
}
