import type { KernelProcessSignalNumber } from "./KernelProcessSignal.ts";

export interface KernelMemoryRegion {
  readonly pointer: number;
  readonly bytes: Uint8Array;
  readonly direction?: "in" | "out" | "inout";
  /** Output reservations carry their capacity without sending the previous contents. */
  readonly length?: number;
}

export interface KernelSyscallRequest {
  readonly name: string;
  readonly args: readonly (number | bigint)[];
  readonly memorySize: number;
  /** A packed reactor reports all its live WASM memories; memorySize still bounds this call's ABI. */
  readonly residentWasmBytes?: number;
  readonly regions: readonly KernelMemoryRegion[];
}

export type KernelSyscallResponse =
  | {
      readonly kind: "return";
      readonly value: number;
      readonly regions: readonly KernelMemoryRegion[];
    }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: KernelProcessSignalNumber };

export interface KernelSyscallPort {
  readonly call: (request: KernelSyscallRequest) => Promise<KernelSyscallResponse>;
}
