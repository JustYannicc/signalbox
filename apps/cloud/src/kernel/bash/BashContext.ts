import type {
  KernelAsyncProgramContext,
  KernelAsyncProgramExecRequest,
} from "../KernelAsyncProgram.ts";

/** Credentials come from the executing owner, never a guest file or host OS. */
export interface KernelBashCredentials {
  readonly uid: number;
  readonly gid: number;
  readonly euid: number;
  readonly egid: number;
  umask: number;
  readonly hostname: string;
}

export type KernelBashExecRequest = KernelAsyncProgramExecRequest;
export type KernelBashProgramContext = KernelAsyncProgramContext;

export interface KernelBashProgramOptions {
  readonly module: WebAssembly.Module;
  readonly credentials: KernelBashCredentials;
}
