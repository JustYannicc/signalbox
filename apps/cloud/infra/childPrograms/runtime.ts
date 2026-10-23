import {
  createChildProgramCatalog,
  type ChildProgramCatalogOptions,
} from "../../src/computer/ChildProgramCatalog.ts";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_GIT_ARTIFACT } from "../../src/kernel/KernelGitProgram.ts";
import { KERNEL_GNU_SED_ARTIFACT } from "../../src/kernel/KernelGnuPrograms.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";
import {
  CHILD_COREUTILS_COMMANDS,
  type ChildCoreutilsCommand,
} from "../../src/computer/ChildProgramSet.ts";
import type { CommandProgramCodes } from "../../src/computer/CommandGateway.ts";
import coreutilsProvenance from "../kernelPrograms/coreutils/provenance.json" with { type: "json" };
import type { ChildWorkerCode } from "../../src/computer/ChildWorkerProgram.ts";
import type {
  ChildProgramSources,
  ChildProgramSourceCode,
  FullChildProgramSources,
} from "./prepare.ts";

export interface SeededChildProgramCatalogOptions extends Omit<
  ChildProgramCatalogOptions,
  "programs"
> {
  readonly programs: ChildProgramSources;
}

/** Executables were hashed by the seed route before any program is registered. */
export function createSeededChildProgramCatalog(options: SeededChildProgramCatalogOptions) {
  return createChildProgramCatalog({
    ...options,
    programs: {
      bash: attachProgramReference(options.programs.bash, KERNEL_BASH_ARTIFACT.sha256),
      busyboxCat: attachProgramReference(
        options.programs.busyboxCat,
        KERNEL_BUSYBOX_ARTIFACT.sha256,
      ),
      ripgrep: attachProgramReference(options.programs.ripgrep, KERNEL_RIPGREP_ARTIFACT.sha256),
    },
  });
}

/** Attaches pinned artifact references for the full product command gateway. */
export function createSeededCommandProgramCodes(
  programs: FullChildProgramSources,
): CommandProgramCodes {
  requireProgramCode(programs.bash, "bash");
  requireProgramCode(programs.busyboxCat, "busybox cat");
  requireProgramCode(programs.busyboxApplets, "busybox applets");
  requireProgramCode(programs.ripgrep, "ripgrep");
  requireProgramCode(programs.git, "git");
  requireProgramCode(programs.sed, "GNU sed");
  const coreutilsPrograms = {} as Record<ChildCoreutilsCommand, ChildWorkerCode>;
  for (const command of CHILD_COREUTILS_COMMANDS) {
    const code = programs.coreutils?.[command];
    requireProgramCode(code, `coreutils ${command}`);
    coreutilsPrograms[command] = attachProgramReference(
      code,
      coreutilsProvenance.commands[command].sha256,
    );
  }
  const coreutils = Object.freeze(coreutilsPrograms);

  return Object.freeze({
    bash: attachProgramReference(programs.bash, KERNEL_BASH_ARTIFACT.sha256),
    busyboxCat: attachProgramReference(programs.busyboxCat, KERNEL_BUSYBOX_ARTIFACT.sha256),
    busyboxApplets: attachProgramReference(programs.busyboxApplets, KERNEL_BUSYBOX_ARTIFACT.sha256),
    ripgrep: attachProgramReference(programs.ripgrep, KERNEL_RIPGREP_ARTIFACT.sha256),
    coreutils,
    git: attachProgramReference(programs.git, KERNEL_GIT_ARTIFACT.sha256),
    sed: attachProgramReference(programs.sed, KERNEL_GNU_SED_ARTIFACT.sha256),
  });
}

export function attachProgramReference(
  code: ChildProgramSourceCode,
  sha256: string,
): ChildWorkerCode {
  if (Object.hasOwn(code.modules, "program.wasm")) {
    throw new Error("Static child graph already contains program.wasm");
  }
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError("Invalid pinned child program hash");
  const sources = Object.freeze({ ...code.modules });
  return Object.freeze({
    ...code,
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
