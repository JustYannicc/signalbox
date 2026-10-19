import { ABI_VERSION, KernelProgramRegistry } from "../../src/kernel/KernelAbi.ts";
import {
  createKernelBashProgram,
  KERNEL_BASH_ARTIFACT,
} from "../../src/kernel/KernelBashProgram.ts";
import { KernelProgramHost } from "../../src/kernel/KernelProgramHost.ts";
import { proofCredentials } from "./ProofWorkspace.mjs";

export function createProofBashHost(module, wakes) {
  const registry = new KernelProgramRegistry();
  const manifest = {
    name: "gnu-bash",
    version: KERNEL_BASH_ARTIFACT.revision,
    abiVersion: ABI_VERSION,
    requiredCapabilities: ["process.wait"],
    entrypoint: "/bin/bash",
  };
  const registered = registry.register(manifest);
  if (registered.status !== "ok") throw new Error(JSON.stringify(registered));
  return new KernelProgramHost({
    registry,
    wakes,
    programs: new Map([
      [
        "/bin/bash",
        {
          manifest,
          implementation: createKernelBashProgram({
            module,
            credentials: { ...proofCredentials, umask: 0o022, hostname: "codex-proof" },
          }),
        },
      ],
    ]),
  });
}
