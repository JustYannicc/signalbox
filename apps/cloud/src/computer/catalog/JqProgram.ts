import { KERNEL_JQ_ARTIFACT } from "../../kernel/KernelJqProgram.ts";
import type { ChildWorkerCode } from "../ChildWorkerCode.ts";
import { childProgramManifest, type ChildProgramFactory } from "./ChildProgramFactory.ts";

/** jq retains its separate pin and the AgentOS host protocol. */
export function createChildJqBinding(options: {
  readonly code: ChildWorkerCode;
  readonly child: ChildProgramFactory;
}) {
  options.child(
    "/usr/bin/jq",
    options.code,
    "coreutils",
    childProgramManifest(
      "@agentos-software/jq",
      KERNEL_JQ_ARTIFACT.version,
      `agentos-jq-${KERNEL_JQ_ARTIFACT.version}:${KERNEL_JQ_ARTIFACT.sha256}`,
    ),
    { pwd: true },
  );
}
