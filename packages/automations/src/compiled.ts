import type { WorkflowDiagnostic, WorkflowGraph, WorkflowMeta } from "@t3tools/contracts";

/**
 * A compiled automation.
 *
 * `script` is the plain module the sandbox runs: types stripped, every step
 * call carrying its graph id as an extra first argument, and imports and
 * `w.run` functions removed. `runModule` holds the rest of the file as JS, minus
 * the workflow itself, exporting the `w.run` functions; it runs in a real
 * runtime with packages and network.
 */
export interface CompiledWorkflow {
  readonly meta: WorkflowMeta;
  readonly graph: WorkflowGraph;
  readonly script: string;
  readonly runModule: string | null;
}

export type WorkflowCompileResult =
  | { readonly ok: true; readonly workflow: CompiledWorkflow }
  | { readonly ok: false; readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> };
