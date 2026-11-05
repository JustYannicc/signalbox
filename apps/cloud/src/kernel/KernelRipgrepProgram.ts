export {
  KERNEL_RIPGREP_ARTIFACT,
  KERNEL_RIPGREP_PROGRAM_MANIFEST,
} from "./KernelProgramArtifacts.ts";
import type { KernelProgramImplementation } from "./KernelProgramHost.ts";

export interface KernelRipgrepProgramOptions {
  readonly module: WebAssembly.Module;
}

/** Runs the pinned ripgrep module with cwd initialized from the prepared FS. */
export function createKernelRipgrepProgram(
  options: KernelRipgrepProgramOptions,
): Extract<KernelProgramImplementation, { readonly kind: "wasm" }> {
  return Object.freeze({
    kind: "wasm" as const,
    module: options.module,
    cwdEnvironment: "PWD" as const,
    sigpipe: "epipe" as const,
  });
}
