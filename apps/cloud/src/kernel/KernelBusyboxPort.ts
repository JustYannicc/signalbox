import type { KernelMemoryRegion, KernelSyscallPort } from "./KernelSyscallPort.ts";

export interface KernelBusyboxCall {
  readonly name: string;
  readonly args: readonly number[];
  readonly memorySize: number;
  readonly regions: readonly KernelMemoryRegion[];
}

export interface KernelBusyboxCallResult {
  readonly value: number;
  readonly regions: readonly KernelMemoryRegion[];
}

/** Bound to one admitted process and its prepared filesystem, never a caller-supplied PID. */
export interface KernelBusyboxPort extends Pick<KernelSyscallPort, "call"> {
  callBusybox(request: KernelBusyboxCall): Promise<KernelBusyboxCallResult>;
}
