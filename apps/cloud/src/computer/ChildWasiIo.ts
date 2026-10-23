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

// path_readlink's resolver returns ENAMETOOLONG above 4096 UTF-8 bytes.
const MAX_RETAINED_READLINK_PATH_BYTES = 4096;

interface ChildWasiIoContinuation {
  readonly iovecTable?: Uint8Array;
  readonly pathBytes?: Uint8Array;
}

interface ChildWasiIoRequest extends KernelSyscallRequest {
  readonly childWasiIoContinuation?: ChildWasiIoContinuation;
}

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
  readonly continuation?: ChildWasiIoContinuation;
}

interface TransferPlan {
  readonly regions: MemoryRegions;
  readonly countPointer: number;
  readonly capacity: number;
  readonly offset: number;
}

interface TransferWindow extends TransferPlan {
  readonly request: KernelSyscallRequest;
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
  if (response.kind !== "return") return { kind: "complete", value: response };

  const window = transferPlan(shape, memory, request.transferOffset ?? 0);
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
    const response = await options.syscalls.call(request);
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

  const saved = previous === undefined ? undefined : readContinuation(previous);
  const argument = (index: number) => Number(args[index]) >>> 0;
  const positioned = name === "fd_pread" || name === "fd_pwrite";
  const countPointer = argument(link ? 5 : positioned || directory ? 4 : 3);
  const inputPointer = argument(1);
  const inputLength = argument(2);
  const inputs: Array<{ pointer: number; bytes: Uint8Array }> = [];
  let table: Uint8Array | undefined;
  if ((read || write) && inputLength <= MAX_IOVECS) {
    table =
      saved?.iovecTable === undefined
        ? previous === undefined
          ? capture(memory, inputPointer, inputLength * 8)
          : captureRequestBytes(previous, inputPointer, inputLength * 8)
        : saved.iovecTable;
    if (table !== undefined) inputs.push({ pointer: inputPointer, bytes: table });
  }

  let length = 0;
  if (read || write) {
    if (table !== undefined) {
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
        saved?.pathBytes !== undefined
          ? saved.pathBytes
          : inputLength <= MAX_RETAINED_READLINK_PATH_BYTES
            ? previous === undefined
              ? capture(memory, inputPointer, inputLength)
              : captureRequestBytes(previous, inputPointer, inputLength)
            : undefined;
      if (path !== undefined) inputs.push({ pointer: inputPointer, bytes: path });
    }
  }

  const continuation = rememberContinuation(saved, table, inputs, link, inputPointer);

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
    ...(continuation === undefined ? {} : { continuation }),
  };
}

function transferWindow(
  shape: TransferShape,
  memory: WebAssembly.Memory,
  offset: number,
  previous?: KernelSyscallRequest,
): TransferWindow {
  const plan = transferPlan(shape, memory, offset);
  const request: ChildWasiIoRequest = {
    name: shape.name,
    args: shape.args,
    memorySize: memory.buffer.byteLength,
    regions: plan.regions.snapshot(shape.inputs),
    transferOffset: offset,
    transferLength: plan.capacity,
    ...(previous === undefined ? {} : { residentWasmBytes: previous.residentWasmBytes }),
    ...(shape.continuation === undefined ? {} : { childWasiIoContinuation: shape.continuation }),
  };
  return { ...plan, request };
}

function transferPlan(
  shape: TransferShape,
  memory: WebAssembly.Memory,
  offset: number,
): TransferPlan {
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

  return { regions, countPointer: shape.countPointer, capacity, offset };
}

function readContinuation(request: KernelSyscallRequest): ChildWasiIoContinuation | undefined {
  const continuation = (request as ChildWasiIoRequest).childWasiIoContinuation;
  return continuation === undefined ? undefined : Object.freeze(continuation);
}

function rememberContinuation(
  previous: ChildWasiIoContinuation | undefined,
  table: Uint8Array | undefined,
  inputs: readonly { readonly pointer: number; readonly bytes: Uint8Array }[],
  link: boolean,
  inputPointer: number,
): ChildWasiIoContinuation | undefined {
  const path = link ? inputs.find((input) => input.pointer === inputPointer)?.bytes : undefined;
  const iovecTable = previous?.iovecTable ?? table;
  const pathBytes = previous?.pathBytes ?? path;
  if (iovecTable === undefined && pathBytes === undefined) return undefined;
  return Object.freeze({
    ...(iovecTable === undefined ? {} : { iovecTable }),
    ...(pathBytes === undefined ? {} : { pathBytes }),
  });
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
