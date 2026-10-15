import type { AutomationError, WorkflowSourceWatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { RunWaitListener } from "../events/runWaits.ts";
import type { AutomationRow } from "../WorkflowStore.ts";
import type { Watcher } from "./sourceWatches.ts";

/**
 * Everyone watching a source right now: live automations' triggers, and
 * running runs' `waitFor` steps. A trigger's id carries its version, so saving
 * it again counts as someone new watching, which lifts a pause.
 */
export const watchersOf = (sources: {
  readonly triggers: Effect.Effect<
    ReadonlyArray<{ readonly automation: AutomationRow; readonly watch: WorkflowSourceWatch }>,
    AutomationError
  >;
  readonly runs: Effect.Effect<ReadonlyArray<RunWaitListener>, AutomationError>;
}) =>
  Effect.gen(function* () {
    const watchers: Watcher[] = [];
    for (const { automation, watch } of yield* sources.triggers)
      watchers.push({
        id: `trigger:${automation.automation_id}@${automation.version}`,
        projectId: automation.project_id,
        watch,
        automation,
      });
    for (const listener of yield* sources.runs) {
      const automation = listener.automation;
      if (!automation) continue;
      for (const watch of listener.watches ?? [])
        watchers.push({
          id: `run:${listener.runId}`,
          runId: listener.runId,
          projectId: listener.projectId,
          watch,
          automation,
        });
    }
    return watchers;
  });
