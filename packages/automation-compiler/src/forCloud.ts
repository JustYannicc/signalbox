import {
  AUTOMATION_COMPILED_FORMAT,
  type AutomationCompiled,
  type WorkflowDiagnostic,
} from "@t3tools/contracts";

import type { WorkflowCompileResult } from "@signalbox/automations/compiled";

export type CompileForCloudResult =
  | { readonly ok: true; readonly compiled: AutomationCompiled }
  | { readonly ok: false; readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> };

/** Stamps the shared compiler result with the cloud artifact format. */
export function forCloud(result: WorkflowCompileResult): CompileForCloudResult {
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
