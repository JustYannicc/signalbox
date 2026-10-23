import { KERNEL_SYSCALL_MAX_IO_BYTES } from "../kernel/KernelSyscallPort.ts";
import type {
  KernelMemoryRegion,
  KernelSyscallPort,
  KernelSyscallResponse,
} from "../kernel/KernelSyscallPort.ts";
import { MAX_IOVECS, MemoryRegions } from "./wasi/MemoryRegions.ts";

type WasmArgument = number | bigint;
type Returned = Extract<KernelSyscallResponse, { kind: "return" }>;
type Terminal = Exclude<KernelSyscallResponse, Returned>;

interface ChildWasiIoOptions {
  readonly name: string;
  readonly args: readonly WasmArgument[];
  readonly memory: WebAssembly.Memory;
  readonly syscalls: KernelSyscallPort;
}

/** Completes oversized guest I/O through fixed-size RPCs. */
export async function childWasiIo(
  options: ChildWasiIoOptions,
): Promise<number | Terminal | undefined> {
  const { name, args, memory } = options;
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
      ? capture(memory, inputPointer, inputLength * 8)
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
      const path = capture(memory, inputPointer, inputLength);
      if (path !== undefined) inputs.push({ pointer: inputPointer, bytes: path });
    }
  }

  let total = 0;
  const finish = () => {
    new DataView(memory.buffer).setUint32(countPointer, total, true);
    return 0;
  };
  for (;;) {
    const capacity = Math.min(KERNEL_SYSCALL_MAX_IO_BYTES, Math.max(0, length - total));
    const regions = new MemoryRegions(memory, capacity);
    regions.add(countPointer, 4, "out");
    if (read || write) {
      regions.addIovecs(inputPointer, inputLength, read ? "out" : "in", {
        offset: total,
        ...(table === undefined ? {} : { table }),
      });
    } else {
      if (link) regions.add(inputPointer, inputLength, "in");
      const buffer = argument(link ? 3 : 1);
      // Keep invalid original buffers absent so the owner's validation retains errno precedence.
      if (buffer + length <= memory.buffer.byteLength) regions.add(buffer + total, capacity, "out");
    }

    let response: KernelSyscallResponse;
    try {
      response = await options.syscalls.call({
        name,
        args,
        memorySize: memory.buffer.byteLength,
        regions: regions.snapshot(inputs),
        transferOffset: total,
        transferLength: capacity,
      });
    } catch (error) {
      if (total > 0) return finish();
      throw error;
    }
    if (response.kind !== "return") return total > 0 ? finish() : response;
    // A count slot may alias data needed by a later window. The aggregate is its only guest write.
    regions.apply(response.regions, { pointer: countPointer, length: 4 });
    if (response.value !== 0) return total > 0 ? finish() : response.value;

    const count = returnedCount(response.regions, countPointer);
    if (count > capacity) throw new TypeError("Invalid syscall transfer count");
    total += count;
    if (
      count === 0 ||
      total >= length ||
      (read && (response.io?.descriptor !== "file" || count < capacity)) ||
      (response.io?.descriptor === "stdio" && response.io.nonblocking) ||
      ((directory || link) && count < capacity)
    )
      return finish();
  }
}

function capture(
  memory: WebAssembly.Memory,
  pointer: number,
  length: number,
): Uint8Array | undefined {
  if (pointer + length > memory.buffer.byteLength) return undefined;
  return new Uint8Array(memory.buffer, pointer, length).slice();
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
