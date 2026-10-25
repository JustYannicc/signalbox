import type { KernelExitStatus } from "./KernelProcessTable.ts";
import type {
  KernelMemoryRegion,
  KernelSyscallPort,
  KernelSyscallRequest,
} from "./KernelSyscallPort.ts";

export interface KernelBashCall extends KernelSyscallRequest {
  readonly namespace: "nimbus_proc" | "env";
  readonly args: readonly number[];
}

export interface KernelBashCallResult {
  readonly value: number;
  readonly regions: readonly KernelMemoryRegion[];
}

export type KernelBashCompletion =
  | { readonly kind: "exit"; readonly status: KernelExitStatus }
  | { readonly kind: "failure"; readonly message: string };

export type KernelBashAdmissionFailure = { readonly kind: "error"; readonly errno: number };

/** Each port is bound to one live process; callers cannot select another PID's resources. */
export interface KernelBashPort extends Pick<KernelSyscallPort, "call"> {
  callBash(request: KernelBashCall): Promise<KernelBashCallResult>;
  fork(): Promise<
    | { readonly kind: "fork"; readonly pid: number; readonly port: KernelBashPort }
    | KernelBashAdmissionFailure
  >;
  wait(
    pid: number,
    options: number,
  ): Promise<
    | { readonly kind: "wait"; readonly pid: number; readonly status?: KernelExitStatus }
    | KernelBashAdmissionFailure
  >;
  exec(request: {
    readonly path: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  }): Promise<(KernelBashCompletion & { readonly kind: "exit" }) | KernelBashAdmissionFailure>;
  complete(result: KernelBashCompletion): Promise<void>;
}
