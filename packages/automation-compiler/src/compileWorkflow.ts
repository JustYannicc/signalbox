import type { WorkflowCompileResult } from "@signalbox/automations/compiled";

import { prepareWorkflow } from "./prepareWorkflow.ts";
import { finishWorkflow } from "./finishWorkflow.ts";
import { parseSync, transformSync } from "./oxc.ts";

/** Native Node/CLI adapter over the same phases the cloud runs in separate isolates. */
export function compileWorkflow(text: string): WorkflowCompileResult {
  const prepared = prepareWorkflow(text, parseSync);
  return prepared.ok ? finishWorkflow(prepared.plan, transformSync) : prepared;
}
