import { KERNEL_GNU_SED_ARTIFACT } from "../../kernel/KernelGnuPrograms.ts";
import type { ChildWorkerCode } from "../ChildWorkerCode.ts";
import { childProgramManifest, type ChildProgramFactory } from "./ChildProgramFactory.ts";

export function createChildSedBindings(options: {
  readonly code: ChildWorkerCode;
  readonly child: ChildProgramFactory;
}) {
  options.child(
    "/bin/sed",
    options.code,
    "busybox",
    childProgramManifest(
      "@gnu/sed",
      KERNEL_GNU_SED_ARTIFACT.version,
      `gnu-sed:${KERNEL_GNU_SED_ARTIFACT.sha256}`,
    ),
  );
}
