import type { KernelProcessSignalNumber } from "./KernelProcessSignal.ts";

export const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;
export const KERNEL_SYSCALL_MAX_IO_BYTES = 1024 * 1024;

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
  /** Child-internal continuation over the original guest arguments. */
  readonly transferOffset?: number;
  readonly transferLength?: number;
}

export type KernelSyscallResponse =
  | {
      readonly kind: "return";
      readonly value: number;
      readonly regions: readonly KernelMemoryRegion[];
      readonly io?: {
        readonly descriptor: "file" | "stdio" | "other";
        readonly nonblocking: boolean;
      };
    }
  | { readonly kind: "exit"; readonly code: number }
  | { readonly kind: "signal"; readonly signal: KernelProcessSignalNumber };

export interface KernelSyscallPort {
  readonly call: (request: KernelSyscallRequest) => Promise<KernelSyscallResponse>;
}
