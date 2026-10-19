import type { WasiDescriptorTable } from "../wasi/internal_wasi_descriptors.ts";
import { asWasiMemory, type WasiMemory } from "../wasi/internal_wasi_memory.ts";
import type { KernelWakeRegistry } from "../KernelWakeRegistry.ts";

export interface AgentOsDescriptorHostOptions {
  readonly memory: () => WebAssembly.Memory | WasiMemory;
  readonly descriptors: WasiDescriptorTable;
  readonly wakes: KernelWakeRegistry;
  readonly asyncMode: boolean;
  readonly currentSignal?: () => AbortSignal | undefined;
}

export function validRange(
  memory: WebAssembly.Memory | WasiMemory,
  pointer: number,
  length: number,
): boolean {
  try {
    asWasiMemory(memory).range(pointer, length);
    return true;
  } catch {
    return false;
  }
}

export function writeU32(
  memory: WebAssembly.Memory | WasiMemory,
  pointer: number,
  value: number,
): void {
  asWasiMemory(memory).u32(pointer, value);
}
