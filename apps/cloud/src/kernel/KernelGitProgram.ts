import { ABI_VERSION } from "./KernelAbi.ts";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import type { KernelProgramImplementation } from "./KernelProgramHost.ts";
import { validateGitCredentials, type KernelGitCredentials } from "./git/KernelGitCredentials.ts";
import { runKernelGitProgram } from "./git/KernelGitRuntime.ts";

export type { KernelGitCredentials } from "./git/KernelGitCredentials.ts";

export const KERNEL_GIT_ARTIFACT = Object.freeze({
  repository: "https://github.com/AshishKumar4/Nimbus",
  revision: "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3",
  path: "packages/worker/wasm/git/git.wasm",
  version: "2.53.0+nimbus.e9f019ab.startup-cwd.1",
  patchSha256: "0ced54937ce31b98038c9368ef91d568a61d91adc0d1e794b11203f1ce84bd35",
  sha256: "87c054c0a772fce3a236f5721f486707461d98144af8a9ff9a1424e40b9b9f36",
  bytes: 3_678_759,
  gitVersion: "2.53.0",
  license: "GPL-2.0-only",
});

export const KERNEL_GIT_PROGRAM_MANIFEST = Object.freeze({
  name: "git",
  version: KERNEL_GIT_ARTIFACT.version,
  abiVersion: ABI_VERSION,
  requiredCapabilities: Object.freeze(["process.spawn", "process.wait", "process.signal"] as const),
  entrypoint: "git-nimbus-2.53.0",
});

export interface KernelGitProgramOptions {
  readonly module: WebAssembly.Module;
  readonly credentials: KernelGitCredentials;
}

/** Uses the pinned no-fork Git module with the caller's filesystem and process state. */
export function createKernelGitProgram(
  options: KernelGitProgramOptions,
): Extract<KernelProgramImplementation, { readonly kind: "async" }> {
  const credentials = validateGitCredentials(options.credentials);
  const module = options.module;
  return Object.freeze({
    kind: "async" as const,
    run: (context: KernelAsyncProgramContext) => runKernelGitProgram(module, credentials, context),
  });
}
