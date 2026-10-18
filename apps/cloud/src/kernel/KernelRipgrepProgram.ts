import { ABI_VERSION } from "./KernelAbi.ts";
import type { KernelProgramImplementation } from "./KernelProgramHost.ts";

export const KERNEL_RIPGREP_ARTIFACT = Object.freeze({
  path: "bin/rg.wasm",
  bytes: 2_207_817,
  sha256: "5c88ecb6dd08b1952585efc3523b397621b62db54e60572449c784c886a17006",
  version: "15.1.0",
});

export const KERNEL_RIPGREP_PROGRAM_MANIFEST = Object.freeze({
  name: "ripgrep",
  version: KERNEL_RIPGREP_ARTIFACT.version,
  abiVersion: ABI_VERSION,
  requiredCapabilities: Object.freeze([]),
  entrypoint: "ripgrep-15.1.0",
});

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
  });
}
