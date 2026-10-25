import type { KernelMemoryRegion, KernelSyscallPort } from "./KernelSyscallPort.ts";

export const KERNEL_COREUTILS_MAX_TRANSFER_BYTES = 16 * 1024 * 1024;

export type KernelCoreutilsNamespace = "host_fs" | "host_process" | "host_net" | "host_user";

export interface KernelCoreutilsCall {
  readonly namespace: KernelCoreutilsNamespace;
  readonly name: string;
  readonly args: readonly (number | bigint)[];
  readonly memorySize: number;
  readonly regions: readonly KernelMemoryRegion[];
}

export interface KernelCoreutilsCallResult {
  readonly value: number | bigint;
  readonly regions: readonly KernelMemoryRegion[];
}

/** Bound to one admitted process and its prepared filesystem, never a caller-supplied PID. */
export interface KernelCoreutilsPort extends KernelSyscallPort {
  callCoreutils(request: KernelCoreutilsCall): Promise<KernelCoreutilsCallResult>;
}
