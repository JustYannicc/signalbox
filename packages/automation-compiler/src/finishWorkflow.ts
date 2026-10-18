import { WORKER_MODULE_START, type WorkflowCompileResult } from "@signalbox/automations/compiled";

import {
  FILENAME,
  WORKER_DEFAULT,
  failure,
  type WorkflowPlan,
  type WorkflowTransform,
} from "./workflowPhases.ts";

/** Transform and assemble the parser's plain-data plan, using the platform's OXC adapter. */
export function finishWorkflow(
  plan: WorkflowPlan,
  transform: WorkflowTransform,
): WorkflowCompileResult {
  const options = { lang: "ts", sourceType: "module" } as const;
  const script = transform(FILENAME, plan.script, options);
  const worker = transform(FILENAME, plan.worker, options);
  const errors = [...script.errors, ...worker.errors];
  if (errors.length > 0) {
    return failure(
      errors.map((error) => ({
        message: `Couldn't prepare the automation to run: ${error.message}`,
        line: 1,
        column: 1,
      })),
    );
  }
  let runModule: string | null = null;
  if (plan.run !== null) {
    const run = transform(FILENAME, plan.run, options);
    if (run.errors.length > 0) {
      return failure([
        {
          message: `Couldn't prepare the w.run functions: ${run.errors[0]!.message}`,
          line: 1,
          column: 1,
        },
      ]);
    }
    runModule = run.code;
  }
  return {
    ok: true,
    workflow: {
      meta: plan.meta,
      graph: plan.graph,
      script: script.code,
      runModule,
      // Each run loads fresh top-level state inside the cached version's isolate.
      workerModule: `${WORKER_MODULE_START}\n${worker.code}\nreturn ${WORKER_DEFAULT};\n}\n`,
    },
  };
}
