export { KERNEL_GIT_ARTIFACT, KERNEL_GIT_PROGRAM_MANIFEST } from "./KernelProgramArtifacts.ts";
import type { KernelAsyncProgramContext } from "./KernelAsyncProgram.ts";
import type { KernelProgramImplementation } from "./KernelProgramHost.ts";
import { validateGitCredentials, type KernelGitCredentials } from "./git/KernelGitCredentials.ts";
import { runKernelGitProgram } from "./git/KernelGitRuntime.ts";

export type { KernelGitCredentials } from "./git/KernelGitCredentials.ts";

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
