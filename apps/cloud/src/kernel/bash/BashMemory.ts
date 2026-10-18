import { WasiError } from "../wasi/internal_wasi_memory.ts";
import { mapErrno } from "../wasi/internal_wasi_calls.ts";
import type { KernelResult } from "../KernelAbi.ts";

export function range(memory: WebAssembly.Memory, pointer: number, length: number): Uint8Array {
  const start = pointer >>> 0;
  const size = length >>> 0;
  if (start + size > memory.buffer.byteLength) throw new WasiError(21);
  return new Uint8Array(memory.buffer, start, size);
}

export function string(memory: WebAssembly.Memory, pointer: number, length?: number): string {
  if (length !== undefined)
    return new TextDecoder("utf-8", { fatal: true }).decode(range(memory, pointer, length));
  const bytes = range(memory, pointer, memory.buffer.byteLength - (pointer >>> 0));
  const end = bytes.indexOf(0);
  if (end < 0 || end > 65_536) throw new WasiError(37);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
}

export function flatStrings(memory: WebAssembly.Memory, pointer: number, length: number): string[] {
  if (length >>> 0 > 65_536) throw new WasiError(1);
  const bytes = range(memory, pointer, length);
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new WasiError(28);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)).split("\0");
}

export function errno(error: unknown): number {
  try {
    return mapErrno(error);
  } catch {
    return 29;
  }
}

export function resultErrno(
  result: Exclude<KernelResult<unknown>, { status: "ok" }>,
  operation: "fork" | "waitpid" | "kill" | "getpgid" | "getppid",
): number {
  if (result.status === "would_block") return 6;
  switch (result.error.code) {
    case "NOT_FOUND":
      return operation === "waitpid" ? 12 : 71;
    case "PERMISSION_DENIED":
      return 63;
    case "INVALID_ARGUMENT":
      return 28;
    case "INVALID_HANDLE":
      return operation === "waitpid" ? 12 : 71;
    case "RESOURCE_LIMIT":
      return operation === "fork" ? 6 : 48;
    case "UNSUPPORTED":
      return 58;
    case "CANCELLED":
      return 11;
    default:
      return 29;
  }
}

export function environment(values: readonly string[]): Readonly<Record<string, string>> {
  const entries = values.map((value) => {
    const at = value.indexOf("=");
    if (at < 1) throw new WasiError(28);
    return [value.slice(0, at), value.slice(at + 1)] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}
