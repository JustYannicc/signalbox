import type { KernelCommand, KernelCommandExit } from "./KernelCommandForwarder.ts";
import type { KernelProgramBinding } from "./KernelProgramHost.ts";
import type { KernelProcessAdmissionPort } from "./KernelProcessAdmissionPort.ts";
import type { KernelSyscallPort } from "./KernelSyscallPort.ts";
import type { KernelBusyboxPort } from "./KernelBusyboxPort.ts";
import type { KernelCoreutilsPort } from "./KernelCoreutilsPort.ts";
import type { KernelGitPort } from "./KernelGitPort.ts";

export type KernelChildHostKind = "bash" | "syscall" | "busybox" | "coreutils" | "git";
export interface KernelChildRegistration {
  readonly executable: string;
  readonly manifest: KernelProgramBinding["manifest"];
  readonly hostKind: KernelChildHostKind;
  readonly sigpipe?: "epipe";
  readonly pwd?: true;
  readonly artifact?: { readonly bytes: number; readonly sha256: string };
}

export interface KernelChildHostPort
  extends KernelSyscallPort, KernelBusyboxPort, KernelCoreutilsPort, KernelGitPort {}

/** Resource and cancellation capabilities cross RPC; filesystem and process objects stay local. */
export interface KernelChildDispatchPort {
  describe(): Promise<{
    readonly command: KernelCommand;
    readonly requester: KernelProcessAdmissionPort;
  }>;
  open(): Promise<KernelChildHostPort>;
  aborted(): Promise<{ readonly aborted: boolean; readonly reason?: unknown }>;
  close(): Promise<void>;
  cancel(reason?: unknown): Promise<void>;
}

export interface KernelChildExecutionPort {
  run(process: KernelChildDispatchPort): Promise<KernelCommandExit>;
  cancel(reason?: unknown): Promise<void>;
}
