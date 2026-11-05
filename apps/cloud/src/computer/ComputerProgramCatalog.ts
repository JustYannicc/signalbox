import { KERNEL_BASH_ARTIFACT } from "../kernel/KernelProgramArtifacts.ts";
import { KERNEL_RIPGREP_PROGRAM_MANIFEST } from "../kernel/KernelProgramArtifacts.ts";
import { KERNEL_COREUTILS_VERSION } from "../kernel/KernelProgramArtifacts.ts";
import { KERNEL_GIT_PROGRAM_MANIFEST } from "../kernel/KernelProgramArtifacts.ts";
import { CHILD_COREUTILS_COMMANDS } from "./ChildProgramSet.ts";
import type { ChildProgramCodes } from "./ChildProgramCodes.ts";

export type {
  ComputerCatalogProgram,
  ComputerProgramHostKind,
} from "./catalog/ChildProgramFactory.ts";
import {
  childProgramManifest as manifest,
  type ChildProgramFactory,
  type ComputerCatalogProgram,
} from "./catalog/ChildProgramFactory.ts";
import { createChildBusyboxBindings } from "./catalog/BusyboxPrograms.ts";
import { createChildSedBindings } from "./catalog/SedPrograms.ts";
import { createChildUgrepBindings } from "./catalog/UgrepPrograms.ts";
import { createChildJqBinding } from "./catalog/JqProgram.ts";
import { registerProgramAliases } from "./catalog/ProgramAliases.ts";

/** One catalog supplies both local kernel registrations and Computer's execution owner. */
export function createComputerProgramCatalog(codes: ChildProgramCodes) {
  const programs = new Map<string, ComputerCatalogProgram>();
  const add: ChildProgramFactory = (executable, code, hostKind, pin, extras = {}) => {
    programs.set(
      executable,
      Object.freeze({
        executable,
        implementation: executable,
        code,
        hostKind,
        manifest: pin,
        ...extras,
      }),
    );
  };
  const bash = Object.freeze({
    ...manifest(
      "@nimbus/bash",
      KERNEL_BASH_ARTIFACT.version,
      `nimbus-bash:${KERNEL_BASH_ARTIFACT.sha256}`,
    ),
    requiredCapabilities: Object.freeze([
      "process.spawn" as const,
      "process.wait" as const,
      "process.signal" as const,
    ]),
  });
  add("/bin/bash", codes.bash, "bash", bash);
  programs.set(
    "/bin/sh",
    Object.freeze({
      ...programs.get("/bin/bash")!,
      executable: "/bin/sh",
      manifest: Object.freeze({ ...bash, name: "@nimbus/sh" }),
    }),
  );
  createChildBusyboxBindings({ programs: codes, child: add });
  if (codes.sed !== undefined) createChildSedBindings({ code: codes.sed, child: add });
  if (codes.ugrep !== undefined) createChildUgrepBindings({ code: codes.ugrep, child: add });
  add("/bin/rg", codes.ripgrep, "syscall", KERNEL_RIPGREP_PROGRAM_MANIFEST, {
    sigpipe: "epipe",
    pwd: true,
  });
  for (const command of CHILD_COREUTILS_COMMANDS) {
    const code = codes.coreutils?.[command];
    if (code !== undefined)
      add(
        `/bin/${command}`,
        code,
        "coreutils",
        manifest(
          `@agentos-software/coreutils/${command}`,
          KERNEL_COREUTILS_VERSION,
          `coreutils-${KERNEL_COREUTILS_VERSION}:${command}`,
        ),
        { pwd: true },
      );
  }
  if (codes.jq !== undefined) createChildJqBinding({ code: codes.jq, child: add });
  if (codes.git !== undefined) add("/usr/bin/git", codes.git, "git", KERNEL_GIT_PROGRAM_MANIFEST);
  const aliases = registerProgramAliases(programs);
  return { programs, aliases };
}
