import { KERNEL_UGREP_ARTIFACT } from "../../kernel/KernelUgrepProgram.ts";
import { CHILD_UGREP_EXECUTABLES } from "../ChildProgramSet.ts";
import type { ChildWorkerCode } from "../ChildWorkerCode.ts";
import { childProgramManifest, type ChildProgramFactory } from "./ChildProgramFactory.ts";

export function createChildUgrepBindings(options: {
  readonly code: ChildWorkerCode;
  readonly child: ChildProgramFactory;
}) {
  for (const executable of CHILD_UGREP_EXECUTABLES)
    options.child(
      executable,
      options.code,
      "busybox",
      childProgramManifest(
        executable === "/bin/ugrep" ? "@ugrep/ugrep" : "@ugrep/ugrep:claude-multicall",
        KERNEL_UGREP_ARTIFACT.version,
        `ugrep:${KERNEL_UGREP_ARTIFACT.sha256}`,
      ),
    );
}
