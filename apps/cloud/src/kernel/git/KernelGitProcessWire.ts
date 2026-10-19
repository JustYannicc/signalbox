import type { KernelResult } from "../KernelAbi.ts";
import { KERNEL_GIT_MAX_BUFFER_BYTES } from "../KernelGitMemoryPlan.ts";
import { asWasiMemory, WasiError, type WasiMemory } from "../wasi/internal_wasi_memory.ts";

export const GIT_ERRNO = Object.freeze({
  again: 6,
  resourceLimit: 6,
  fault: 21,
  invalidArgument: 28,
  noChild: 12,
  io: 29,
  noEntry: 44,
  noProcess: 71,
  noSpace: 51,
  unsupported: 58,
});

const MAX_STRINGS = 65_536;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type KernelGitMemory = WebAssembly.Memory | WasiMemory;

export function decodeGitStrings(
  memory: KernelGitMemory,
  pointer: number,
  length: number,
): string[] | number {
  const start = pointer >>> 0;
  const size = length >>> 0;
  if (size > KERNEL_GIT_MAX_BUFFER_BYTES) return GIT_ERRNO.invalidArgument;
  if (!validGitMemoryRange(memory, start, size)) return GIT_ERRNO.fault;
  if (size === 0) return [];
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = gitMemoryRange(memory, start, size);
  } catch {
    return GIT_ERRNO.fault;
  }
  const result: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(0, offset);
    if (end < 0) return GIT_ERRNO.invalidArgument;
    try {
      result.push(decoder.decode(bytes.subarray(offset, end)));
    } catch {
      return GIT_ERRNO.invalidArgument;
    }
    if (result.length > MAX_STRINGS) return GIT_ERRNO.invalidArgument;
    offset = end + 1;
  }
  return result;
}

export function decodeGitBytes(
  memory: KernelGitMemory,
  pointer: number,
  length: number,
): string | number {
  const start = pointer >>> 0;
  const size = length >>> 0;
  if (size > KERNEL_GIT_MAX_BUFFER_BYTES) return GIT_ERRNO.invalidArgument;
  if (!validGitMemoryRange(memory, start, size)) return GIT_ERRNO.fault;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = gitMemoryRange(memory, start, size);
  } catch {
    return GIT_ERRNO.fault;
  }
  if (bytes.includes(0)) return GIT_ERRNO.invalidArgument;
  try {
    return decoder.decode(bytes);
  } catch {
    return GIT_ERRNO.invalidArgument;
  }
}

export function decodeGitEnvironment(
  entries: readonly string[],
): Record<string, string> | undefined {
  const env: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) return undefined;
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

export function gitSpawnFileAction(fd: number, sourceFd: number) {
  const fields = { fd, sourceFd, flags: 0, mode: 0 } as const;
  return sourceFd < 0
    ? Object.freeze({ kind: "close" as const, ...fields })
    : Object.freeze({ kind: "dup2" as const, ...fields });
}

export function gitCloseInheritedPipeAction(fd: number) {
  return Object.freeze({ kind: "close" as const, fd, sourceFd: 0, flags: 0, mode: 0 });
}

export function validGitMemoryRange(
  memory: KernelGitMemory,
  pointer: number,
  length: number,
): boolean {
  const start = pointer >>> 0;
  return (
    Number.isSafeInteger(length) && length >= 0 && start <= asWasiMemory(memory).byteLength - length
  );
}

export function gitMemoryRange(
  memory: KernelGitMemory,
  pointer: number,
  length: number,
): Uint8Array<ArrayBuffer> {
  if (!validGitMemoryRange(memory, pointer, length)) throw new WasiError(GIT_ERRNO.fault);
  try {
    return asWasiMemory(memory).range(pointer, length);
  } catch (error) {
    if (error instanceof WasiError) throw error;
    throw new WasiError(GIT_ERRNO.fault);
  }
}

export function gitMemoryView(memory: KernelGitMemory, pointer: number, length: number): DataView {
  const bytes = gitMemoryRange(memory, pointer, length);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function gitErrnoOf(
  result: Exclude<KernelResult<unknown>, { status: "would_block" }>,
): number {
  return result.status === "ok" ? 0 : gitErrnoForKernelError(result.error.code);
}

export function gitErrnoForKernelError(code: string): number {
  switch (code) {
    case "INVALID_ARGUMENT":
      return GIT_ERRNO.invalidArgument;
    case "NOT_FOUND":
      return GIT_ERRNO.noEntry;
    case "PERMISSION_DENIED":
      return 63;
    case "RESOURCE_LIMIT":
      return GIT_ERRNO.resourceLimit;
    case "CANCELLED":
      return 11;
    case "EXPIRED":
      return 73;
    case "INVALID_HANDLE":
      return 71;
    case "UNSUPPORTED":
      return GIT_ERRNO.unsupported;
    default:
      return GIT_ERRNO.io;
  }
}

export function encodeGitWaitStatus(status: {
  readonly exitCode: number;
  readonly signal: number;
  readonly coreDumped: boolean;
}): number {
  if (status.signal !== 0) return status.signal | (status.coreDumped ? 0x80 : 0);
  return (status.exitCode & 0xff) << 8;
}
