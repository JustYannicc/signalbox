import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import {
  KERNEL_BUSYBOX_ARTIFACT,
  PRODUCT_COMPUTER_BUSYBOX_ARTIFACT,
} from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_GIT_ARTIFACT } from "../../src/kernel/KernelGitProgram.ts";
import { KERNEL_JQ_ARTIFACT } from "../../src/kernel/KernelJqProgram.ts";
import { KERNEL_GNU_SED_ARTIFACT } from "../../src/kernel/KernelGnuPrograms.ts";
import { KERNEL_UGREP_ARTIFACT } from "../../src/kernel/KernelUgrepProgram.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";
import {
  CHILD_COREUTILS_COMMANDS,
  type ChildCoreutilsCommand,
} from "../../src/computer/ChildProgramSet.ts";
import type { CommandProgramCodes } from "../../src/computer/CommandGateway.ts";
import coreutilsProvenance from "../kernelPrograms/coreutils/provenance.json" with { type: "json" };
import type { ChildWorkerCode } from "../../src/computer/ChildWorkerProgram.ts";
import type { ChildProgramSourceCode, FullChildProgramSources } from "./prepare.ts";

/** Attaches pinned artifact references for the full product command gateway. */
export function createSeededCommandProgramCodes(
  programs: FullChildProgramSources,
): CommandProgramCodes {
  requireProgramCode(programs.bash, "bash");
  requireProgramCode(programs.busyboxCat, "busybox cat");
  requireProgramCode(programs.busyboxApplets, "busybox applets");
  requireProgramCode(programs.productBusyboxApplets, "ProductComputer BusyBox applets");
  requireProgramCode(programs.ripgrep, "ripgrep");
  requireProgramCode(programs.git, "git");
  requireProgramCode(programs.sed, "GNU sed");
  requireProgramCode(programs.jq, "jq");
  requireProgramCode(programs.ugrep, "ugrep");
  const coreutilsPrograms = {} as Record<ChildCoreutilsCommand, ChildWorkerCode>;
  for (const command of CHILD_COREUTILS_COMMANDS) {
    const code = programs.coreutils?.[command];
    requireProgramCode(code, `coreutils ${command}`);
    coreutilsPrograms[command] = attachProgramReference(
      code,
      coreutilsProvenance.commands[command],
    );
  }
  const coreutils = Object.freeze(coreutilsPrograms);

  return Object.freeze({
    bash: attachProgramReference(programs.bash, KERNEL_BASH_ARTIFACT),
    busyboxCat: attachProgramReference(programs.busyboxCat, KERNEL_BUSYBOX_ARTIFACT),
    busyboxApplets: attachProgramReference(programs.busyboxApplets, KERNEL_BUSYBOX_ARTIFACT),
    productBusyboxApplets: attachProgramReference(
      programs.productBusyboxApplets,
      PRODUCT_COMPUTER_BUSYBOX_ARTIFACT,
    ),
    ripgrep: attachProgramReference(programs.ripgrep, KERNEL_RIPGREP_ARTIFACT),
    coreutils,
    git: attachProgramReference(programs.git, KERNEL_GIT_ARTIFACT),
    sed: attachProgramReference(programs.sed, KERNEL_GNU_SED_ARTIFACT),
    jq: attachProgramReference(programs.jq, KERNEL_JQ_ARTIFACT),
    ugrep: attachProgramReference(programs.ugrep, KERNEL_UGREP_ARTIFACT),
  });
}

export function attachProgramReference(
  code: ChildProgramSourceCode,
  artifact: { readonly bytes: number; readonly sha256: string },
): ChildWorkerCode {
  const { bytes, sha256 } = artifact;
  if (Object.hasOwn(code.modules, "program.wasm")) {
    throw new Error("Static child graph already contains program.wasm");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError("Invalid pinned child program hash");
  if (!Number.isSafeInteger(bytes) || bytes < 0)
    throw new TypeError("Invalid pinned child program size");
  const sources = Object.freeze({ ...code.modules });
  return Object.freeze({
    ...code,
    executableArtifact: Object.freeze({ bytes, sha256 }),
    modules: () =>
      Object.freeze({
        ...sources,
        "program.wasm": Object.freeze({ wasmReference: sha256 }),
      }),
  });
}

function requireProgramCode(
  code: ChildProgramSourceCode | undefined,
  label: string,
): asserts code is ChildProgramSourceCode {
  if (code === undefined) throw new Error(`Prepared child program is missing ${label}`);
}
