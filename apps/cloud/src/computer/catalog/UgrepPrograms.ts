import { KERNEL_UGREP_ARTIFACT } from "../../kernel/KernelUgrepProgram.ts";
import { CHILD_UGREP_EXECUTABLES } from "../ChildProgramSet.ts";
import type { ChildWorkerCode } from "../ChildWorkerCode.ts";
import { childProgramManifest, type ChildProgramFactory } from "./ChildProgramFactory.ts";

export function createChildUgrepBindings(options: {
  readonly code: ChildWorkerCode;
  readonly child: ChildProgramFactory;
}) {
  for (const executable of CHILD_UGREP_EXECUTABLES) {
    const name =
      executable === "/bin/ugrep"
        ? "@ugrep/ugrep"
        : executable === "/bin/grep"
          ? "@ugrep/grep"
          : "@ugrep/ugrep:claude-multicall";
    options.child(
      executable,
      options.code,
      "busybox",
      childProgramManifest(
        name,
        KERNEL_UGREP_ARTIFACT.version,
        "ugrep:" + KERNEL_UGREP_ARTIFACT.sha256,
      ),
    );
  }
}
