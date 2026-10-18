import type { WorkflowDiagnostic, WorkflowGraph, WorkflowMeta } from "@t3tools/contracts";

export const FILENAME = "automation.ts";
export const WORKER_DEFAULT = "__signalboxWorkflow";

/** RPC-safe output of parse/analyze. No AST, analyzer, native handles or source execution. */
export interface WorkflowPlan {
  readonly meta: WorkflowMeta;
  readonly graph: WorkflowGraph;
  readonly script: string;
  readonly worker: string;
  readonly run: string | null;
}

export type WorkflowFailure = {
  readonly ok: false;
  readonly diagnostics: ReadonlyArray<WorkflowDiagnostic>;
};
export type WorkflowPreparation =
  | { readonly ok: true; readonly plan: WorkflowPlan }
  | WorkflowFailure;

export function failure(diagnostics: ReadonlyArray<WorkflowDiagnostic>): WorkflowFailure {
  const seen = new Set<string>();
  const unique = diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.line}:${diagnostic.column}:${diagnostic.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => a.line - b.line || a.column - b.column);
  return { ok: false, diagnostics: unique.slice(0, 50) };
}

/** Only the transformer fields the compiler uses; native and WASI enums have nominally different types. */
export type WorkflowTransform = (
  filename: string,
  source: string,
  options: { readonly lang: "ts"; readonly sourceType: "module" },
) => { readonly code: string; readonly errors: ReadonlyArray<{ readonly message: string }> };
