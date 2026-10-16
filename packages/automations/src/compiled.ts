import type { WorkflowDiagnostic, WorkflowGraph, WorkflowMeta } from "@t3tools/contracts";

/**
 * A compiled automation.
 *
 * `script` is the plain module the sandbox runs: types stripped, every step
 * call carrying its graph id as an extra first argument, and imports and
 * `w.run` functions removed. `runModule` holds the rest of the file as JS, minus
 * the workflow itself, exporting the `w.run` functions; it runs in a real
 * runtime with packages and network.
 *
 * `workerModule` is `script` as a Dynamic Worker module for the cloud engine:
 * `export function load(workflow) { …the file's code… return <default export>; }`.
 * The isolate is shared by every run of a version, so each run calls `load`
 * (passing its `workflow` wrapper) and gets top-level state of its own.
 * Versions compiled before it existed don't have it.
 */
export interface CompiledWorkflow {
  readonly meta: WorkflowMeta;
  readonly graph: WorkflowGraph;
  readonly script: string;
  readonly runModule: string | null;
  readonly workerModule?: string;
}

/** How every `workerModule` starts; the cloud checks for it before saving one it didn't compile. */
export const WORKER_MODULE_START = "export function load(workflow) {";

export type WorkflowCompileResult =
  | { readonly ok: true; readonly workflow: CompiledWorkflow }
  | { readonly ok: false; readonly diagnostics: ReadonlyArray<WorkflowDiagnostic> };
