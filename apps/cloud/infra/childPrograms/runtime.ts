import {
  createChildProgramCatalog,
  type ChildProgramCatalogOptions,
} from "../../src/computer/ChildProgramCatalog.ts";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";
import type { ChildProgramSources } from "./prepare.ts";
import { attachProgramReference } from "./programCodes.ts";

export { attachProgramReference, createSeededCommandProgramCodes } from "./programCodes.ts";

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
      bash: attachProgramReference(options.programs.bash, KERNEL_BASH_ARTIFACT),
      busyboxCat: attachProgramReference(options.programs.busyboxCat, KERNEL_BUSYBOX_ARTIFACT),
      ripgrep: attachProgramReference(options.programs.ripgrep, KERNEL_RIPGREP_ARTIFACT),
    },
  });
}
