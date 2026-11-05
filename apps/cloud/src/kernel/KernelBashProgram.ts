export { KERNEL_BASH_ARTIFACT } from "./KernelProgramArtifacts.ts";
import { runBashProgram } from "./bash/BashRuntime.ts";
import type { KernelBashProgramContext, KernelBashProgramOptions } from "./bash/BashContext.ts";
export type {
  KernelBashCredentials,
  KernelBashExecRequest,
  KernelBashProgramContext,
  KernelBashProgramOptions,
} from "./bash/BashContext.ts";

/** GNU Bash's Asyncify continuations use the caller's canonical kernel resources. */
export function createKernelBashProgram(options: KernelBashProgramOptions) {
  for (const value of [
    options.credentials.uid,
    options.credentials.gid,
    options.credentials.euid,
    options.credentials.egid,
  ]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
      throw new RangeError("Bash credentials must contain unsigned 32-bit identifiers");
    }
  }
  if (!Number.isInteger(options.credentials.umask) || (options.credentials.umask & ~0o777) !== 0) {
    throw new RangeError("Bash umask must contain only permission bits");
  }
  const credentials = Object.freeze({ ...options.credentials });
  return Object.freeze({
    kind: "async" as const,
    run: (context: KernelBashProgramContext) =>
      runBashProgram(options.module, credentials, context),
  });
}
