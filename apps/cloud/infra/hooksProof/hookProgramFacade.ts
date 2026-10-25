import { KERNEL_HOOK_PROGRAM_MANIFEST } from "../../src/hooks/HookProgram.ts";

export const HOOK_PROGRAM_FACADE = [
  "signalbox-kernel-program-facade",
  `name=${KERNEL_HOOK_PROGRAM_MANIFEST.name}`,
  `version=${KERNEL_HOOK_PROGRAM_MANIFEST.version}`,
  `abiVersion=${KERNEL_HOOK_PROGRAM_MANIFEST.abiVersion}`,
  `entrypoint=${KERNEL_HOOK_PROGRAM_MANIFEST.entrypoint}`,
  "",
].join("\n");
