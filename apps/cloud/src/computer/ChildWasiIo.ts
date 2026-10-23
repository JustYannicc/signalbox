import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../kernel/KernelSyscallPort.ts";
import type {
  KernelMemoryRegion,
  KernelSyscallPort,
  KernelSyscallRequest,
  KernelSyscallResponse,
} from "../kernel/KernelSyscallPort.ts";
import { MAX_IOVECS, MemoryRegions } from "./wasi/MemoryRegions.ts";

type WasmArgument = number | bigint;
type Returned = Extract<KernelSyscallResponse, { kind: "return" }>;
type Terminal = Exclude<KernelSyscallResponse, Returned>;
type ChildWasiIoValue = number | Terminal;

interface ChildWasiIoOptions {
  readonly name: string;
  readonly args: readonly WasmArgument[];
  readonly memory: WebAssembly.Memory;
  readonly syscalls: KernelSyscallPort;
}

interface TransferOptions {
  readonly name: string;
  readonly args: readonly WasmArgument[];
  readonly memory: WebAssembly.Memory;
  readonly previous?: KernelSyscallRequest;
  readonly offset?: number;
}

interface TransferShape {
  readonly name: string;
  readonly args: readonly WasmArgument[];
  readonly read: boolean;
  readonly write: boolean;
  readonly directory: boolean;
  readonly link: boolean;
  readonly countPointer: number;
  readonly inputPointer: number;
  readonly inputLength: number;
  readonly length: number;
  readonly inputs: readonly { readonly pointer: number; readonly bytes: Uint8Array }[];
}

interface TransferWindow {
  readonly request: KernelSyscallRequest;
  readonly regions: MemoryRegions;
  readonly countPointer: number;
  readonly capacity: number;
  readonly offset: number;
  readonly shape: TransferShape;
}

export type ChildWasiIoProgress =
  | { readonly kind: "continue"; readonly request: KernelSyscallRequest }
  | { readonly kind: "complete"; readonly value: ChildWasiIoValue };

/** Builds one fixed-size syscall from a WASI I/O call or its captured continuation. */
export function childWasiIoWindow(options: TransferOptions): KernelSyscallRequest | undefined {
  const shape = transferShape(options);
  if (shape === undefined) return undefined;
  return transferWindow(
    shape,
    options.memory,
    options.offset ?? options.previous?.transferOffset ?? 0,
  ).request;
}

/** Applies one returned window and either finishes the guest call or describes its next window. */
export function applyChildWasiIoWindow(options: {
  readonly request: KernelSyscallRequest;
  readonly response: KernelSyscallResponse;
  readonly memory: WebAssembly.Memory;
}): ChildWasiIoProgress | undefined {
  const { request, response, memory } = options;
  const shape = transferShape({
    name: request.name,
    args: request.args,
    memory,
    previous: request,
  });
  if (shape === undefined) return undefined;

  const window = transferWindow(shape, memory, request.transferOffset ?? 0);
  if (response.kind !== "return") {
    return {
      kind: "complete",
      value: window.offset > 0 ? finish(memory, window.countPointer, window.offset) : response,
    };
  }

  window.regions.apply(response.regions, { pointer: window.countPointer, length: 4 });
  if (response.value !== 0) {
    return {
      kind: "complete",
      value:
        window.offset > 0 ? finish(memory, window.countPointer, window.offset) : response.value,
    };
  }

  const count = returnedCount(response.regions, window.countPointer);
  if (count > window.capacity) throw new TypeError("Invalid syscall transfer count");
  const total = window.offset + count;
  if (finished(shape, response, total, count, window.capacity)) {
    return { kind: "complete", value: finish(memory, window.countPointer, total) };
  }

  const next = transferWindow(shape, memory, total, request).request;
  return { kind: "continue", request: next };
}

/** Completes oversized guest I/O through fixed-size RPCs. */
export async function childWasiIo(
  options: ChildWasiIoOptions,
): Promise<ChildWasiIoValue | undefined> {
  let request = childWasiIoWindow(options);
  if (request === undefined) return undefined;

  for (;;) {
    let response: KernelSyscallResponse;
    try {
      response = await options.syscalls.call(request);
    } catch (error) {
      const offset = request.transferOffset ?? 0;
      if (offset > 0) {
        const shape = transferShape({ ...options, previous: request });
        if (shape === undefined) throw error;
        return finish(options.memory, shape.countPointer, offset);
      }
      throw error;
    }

    const progress = applyChildWasiIoWindow({ request, response, memory: options.memory });
    if (progress === undefined) return undefined;
    if (progress.kind === "complete") return progress.value;
    request = progress.request;
  }
}

function transferShape(options: TransferOptions): TransferShape | undefined {
  const { name, args, memory, previous } = options;
  const read = name === "fd_read" || name === "fd_pread";
  const write = name === "fd_write" || name === "fd_pwrite";
  const directory = name === "fd_readdir";
  const link = name === "path_readlink";
  if (!read && !write && !directory && !link) return undefined;

  const argument = (index: number) => Number(args[index]) >>> 0;
  const positioned = name === "fd_pread" || name === "fd_pwrite";
  const countPointer = argument(link ? 5 : positioned || directory ? 4 : 3);
  const inputPointer = argument(1);
  const inputLength = argument(2);
  const inputs: Array<{ pointer: number; bytes: Uint8Array }> = [];
  const table =
    (read || write) && inputLength <= MAX_IOVECS
      ? previous === undefined
        ? capture(memory, inputPointer, inputLength * 8)
        : captureRequestBytes(previous, inputPointer, inputLength * 8)
      : undefined;

  let length = 0;
  if (read || write) {
    if (table !== undefined) {
      inputs.push({ pointer: inputPointer, bytes: table });
      const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
      for (let index = 0; index < inputLength; index++)
        length += view.getUint32(index * 8 + 4, true);
      // WASI reports a u32 count, even when overlapping vectors name more than 4 GiB.
      length = Math.min(length, 0xffff_ffff);
    }
  } else {
    length = argument(link ? 4 : 2);
    if (link) {
      const path =
        previous === undefined
          ? capture(memory, inputPointer, inputLength)
          : captureRequestBytes(previous, inputPointer, inputLength);
      if (path !== undefined) inputs.push({ pointer: inputPointer, bytes: path });
    }
  }

  return {
    name,
    args,
    read,
    write,
    directory,
    link,
    countPointer,
    inputPointer,
    inputLength,
    length,
    inputs,
  };
}

function transferWindow(
  shape: TransferShape,
  memory: WebAssembly.Memory,
  offset: number,
  previous?: KernelSyscallRequest,
): TransferWindow {
  const capacity = Math.min(KERNEL_SYSCALL_MAX_IO_BYTES, Math.max(0, shape.length - offset));
  const regions = new MemoryRegions(memory, capacity);
  regions.add(shape.countPointer, 4, "out");
  if (shape.read || shape.write) {
    const table = shape.inputs.find((input) => input.pointer === shape.inputPointer)?.bytes;
    regions.addIovecs(shape.inputPointer, shape.inputLength, shape.read ? "out" : "in", {
      offset,
      ...(table === undefined ? {} : { table }),
    });
  } else {
    if (shape.link) regions.add(shape.inputPointer, shape.inputLength, "in");
    const buffer = Number(shape.args[shape.link ? 3 : 1]) >>> 0;
    if (buffer + shape.length <= memory.buffer.byteLength)
      regions.add(buffer + offset, capacity, "out");
  }

  const request: KernelSyscallRequest = {
    name: shape.name,
    args: shape.args,
    memorySize: memory.buffer.byteLength,
    regions: regions.snapshot(shape.inputs),
    transferOffset: offset,
    transferLength: capacity,
    ...(previous === undefined ? {} : { residentWasmBytes: previous.residentWasmBytes }),
  };
  return { request, regions, countPointer: shape.countPointer, capacity, offset, shape };
}

function finished(
  shape: TransferShape,
  response: Returned,
  total: number,
  count: number,
  capacity: number,
): boolean {
  return (
    count === 0 ||
    total >= shape.length ||
    (shape.read && (response.io?.descriptor !== "file" || count < capacity)) ||
    (response.io?.descriptor === "stdio" && response.io.nonblocking) ||
    ((shape.directory || shape.link) && count < capacity)
  );
}

function finish(memory: WebAssembly.Memory, countPointer: number, total: number): number {
  new DataView(memory.buffer).setUint32(countPointer, total, true);
  return 0;
}

function capture(
  memory: WebAssembly.Memory,
  pointer: number,
  length: number,
): Uint8Array | undefined {
  if (pointer + length > memory.buffer.byteLength) return undefined;
  return new Uint8Array(memory.buffer, pointer, length).slice();
}

function captureRequestBytes(
  request: KernelSyscallRequest,
  pointer: number,
  length: number,
): Uint8Array | undefined {
  if (pointer + length > request.memorySize) return undefined;
  const bytes = new Uint8Array(length);
  let copied = 0;
  for (const region of request.regions) {
    if (region.direction === "out") continue;
    const first = Math.max(pointer, region.pointer);
    const last = Math.min(pointer + length, region.pointer + region.bytes.byteLength);
    if (first >= last) continue;
    bytes.set(
      region.bytes.subarray(first - region.pointer, last - region.pointer),
      first - pointer,
    );
    copied += last - first;
  }
  return copied === length ? bytes : undefined;
}

function returnedCount(regions: readonly KernelMemoryRegion[], pointer: number): number {
  const bytes = new Uint8Array(4);
  let copied = 0;
  for (const region of regions) {
    const first = Math.max(pointer, region.pointer);
    const last = Math.min(pointer + 4, region.pointer + region.bytes.byteLength);
    if (first >= last) continue;
    bytes.set(
      region.bytes.subarray(first - region.pointer, last - region.pointer),
      first - pointer,
    );
    copied += last - first;
  }
  if (copied !== 4) throw new TypeError("Missing syscall transfer count");
  return new DataView(bytes.buffer).getUint32(0, true);
}
