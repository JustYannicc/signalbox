import type { WasiDescriptorTable } from "../wasi/internal_wasi_descriptors.ts";
import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";

export interface AgentOsDescriptorHostOptions {
  readonly memory: () => WebAssembly.Memory;
  readonly descriptors: WasiDescriptorTable;
  readonly wakes: KernelWakeRegistry;
  readonly asyncMode: boolean;
  readonly currentSignal?: () => AbortSignal | undefined;
}

export function validRange(memory: WebAssembly.Memory, pointer: number, length: number): boolean {
  const start = pointer >>> 0;
  return start <= memory.buffer.byteLength - length;
}

export function writeU32(memory: WebAssembly.Memory, pointer: number, value: number): void {
  new DataView(memory.buffer, pointer >>> 0, 4).setUint32(0, value >>> 0, true);
}
