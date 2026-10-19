import {
  createChildProgramCatalog,
  type ChildProgramCatalogOptions,
} from "../../src/computer/ChildProgramCatalog.ts";
import { KERNEL_BASH_ARTIFACT } from "../../src/kernel/KernelBashProgram.ts";
import { KERNEL_BUSYBOX_ARTIFACT } from "../../src/kernel/KernelBusyboxProgram.ts";
import { KERNEL_RIPGREP_ARTIFACT } from "../../src/kernel/KernelRipgrepProgram.ts";
import type { ChildWorkerCode } from "../../src/computer/ChildWorkerProgram.ts";
import type { ChildProgramSources, ChildProgramSourceCode } from "./prepare.ts";

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
