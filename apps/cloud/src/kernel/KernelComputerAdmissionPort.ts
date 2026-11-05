import type { KernelCommand } from "./KernelCommandForwarder.ts";
import type {
  KernelChildRegistration,
  KernelChildDispatchPort,
} from "./KernelChildDispatchPort.ts";
import type { KernelProcessAdmissionPort } from "./KernelProcessAdmissionPort.ts";
import type { KernelExecutableNamespace } from "./KernelExecutableNamespace.ts";
import type { KernelWorkerDispatchResult, KernelBashDispatcher } from "./KernelBashDispatchPort.ts";

export interface KernelComputerAdmissionInput {
  readonly kind: "command" | "spawn" | "exec";
  readonly command: KernelCommand;
  readonly target:
    | { readonly kind: "resolved"; readonly manifest: KernelChildRegistration["manifest"] }
    | {
        readonly kind: "unsupported";
        readonly code: "NOT_FOUND" | "UNSUPPORTED";
        readonly message: string;
      };
  readonly localOnly: boolean;
}

export interface KernelComputerAdmissionCapture extends KernelExecutableNamespace {
  requester(): Promise<KernelProcessAdmissionPort>;
  assertForwarding(): Promise<void>;
  aborted(): Promise<{ readonly aborted: boolean; readonly reason?: unknown }>;
  revoke(): Promise<void>;
}

export interface ComputerProgramGrant {
  run(process: KernelChildDispatchPort): Promise<KernelWorkerDispatchResult>;
  cancel(reason?: unknown): Promise<void>;
  finished(): Promise<void>;
}

export type ComputerAdmissionResult =
  | { readonly route: "machine"; readonly command: KernelCommand }
  | {
      readonly route: "child";
      readonly registration: KernelChildRegistration;
      readonly grant: ComputerProgramGrant;
    };

export interface ComputerProgramOwnerPort {
  registrations(): Promise<readonly KernelChildRegistration[]>;
  admit(
    id: string,
    input: KernelComputerAdmissionInput,
    kernel: KernelComputerAdmissionCapture,
  ): Promise<ComputerAdmissionResult>;
  cancel(id: string, reason?: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface KernelBashProcessDispatch {
  bash(
    dispatcher: KernelBashDispatcher,
  ): Promise<import("./KernelCommandForwarder.ts").KernelCommandExit>;
  finished(): Promise<void>;
}
