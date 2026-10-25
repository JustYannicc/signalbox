import type { KernelMemoryRegion, KernelSyscallPort } from "./KernelSyscallPort.ts";

export interface KernelGitCall {
  readonly namespace: "nimbus_fs" | "nimbus_proc";
  readonly name: string;
  readonly args: readonly number[];
  readonly memorySize: number;
  readonly regions: readonly KernelMemoryRegion[];
}

export interface KernelGitCallResult {
  readonly value: number;
  readonly regions: readonly KernelMemoryRegion[];
}

/** Binds the unchanged Git imports and WASI calls to one admitted process. */
export interface KernelGitPort extends Pick<KernelSyscallPort, "call"> {
  readonly callGit: (request: KernelGitCall) => Promise<KernelGitCallResult>;
}
