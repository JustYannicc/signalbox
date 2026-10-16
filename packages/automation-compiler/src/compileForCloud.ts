import {
  AUTOMATION_COMPILED_FORMAT,
  type AutomationCompiled,
  type WorkflowDiagnostic,
} from "@t3tools/contracts";

import { compileWorkflow } from "./compileWorkflow.ts";

export type CompileForCloudResult =
  | { readonly ok: true; readonly compiled: AutomationCompiled }
  | { readonly ok: false; readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> };

/**
 * Compiles a file for a cloud that can't compile it, the way a cloud thread's
 * machine and the `signalbox` CLI send `compiled`: stamped with the format the
 * cloud checks before it saves.
 */
export function compileForCloud(source: string): CompileForCloudResult {
  const result = compileWorkflow(source);
  if (!result.ok) return result;
  const { meta, graph, script, runModule, workerModule } = result.workflow;
  // The compiler always makes one; the type allows versions saved before it did.
  if (workerModule === undefined) {
    return { ok: false, diagnostics: [{ line: 1, column: 1, message: "No worker module." }] };
  }
  return {
    ok: true,
    compiled: { format: AUTOMATION_COMPILED_FORMAT, meta, graph, script, runModule, workerModule },
  };
}
