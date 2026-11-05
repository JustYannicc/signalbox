import type { KernelCommand } from "../kernel/KernelCommandForwarder.ts";
import type { KernelProgramBinding } from "../kernel/KernelProgramHost.ts";

export interface ComputerProgramResolution<Binding = KernelProgramBinding> {
  readonly command: KernelCommand;
  readonly unavailable?: { readonly code: "ENOEXEC" | "EACCES"; readonly message: string };
  readonly catalog?: {
    readonly command: KernelCommand;
    readonly binding: Binding;
  };
}
