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
  version: "5.2.37+nimbus.e9f019ab.fd-getfd.1",
  patchSha256: "4ea7a980f9ae121ab1382064ceabf91ead51f0735218a2bdeb372547297fc388",
  sha256: "17caf644602115465f3ef02204e2f67917bfe58d6089c10f77f94863e4c3bd87",
  bytes: 3_887_571,
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
