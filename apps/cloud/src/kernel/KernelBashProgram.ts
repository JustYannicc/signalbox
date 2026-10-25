import { runBashProgram } from "./bash/BashRuntime.ts";
import type { KernelBashProgramContext, KernelBashProgramOptions } from "./bash/BashContext.ts";
export type {
  KernelBashCredentials,
  KernelBashExecRequest,
  KernelBashProgramContext,
  KernelBashProgramOptions,
} from "./bash/BashContext.ts";

export const KERNEL_BASH_ARTIFACT = Object.freeze({
  repository: "https://github.com/AshishKumar4/Nimbus",
  revision: "e9f019ab4e40cb6037aff7e1a0eaf20842578ed3",
  path: "build/bash.async.wasm",
  version: "5.2.37+nimbus.e9f019ab.fd-flags.2",
  patchSha256: "5df897065b403d5a545431edcf7b17453d1c391206b317898013436931acbfb1",
  sha256: "c3e8dc79b9660a21ed1873f8c900a0c1f195d274c183706cf5f68ff9e5fb9e00",
  bytes: 3_890_330,
});

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
