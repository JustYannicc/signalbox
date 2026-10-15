import type { AutomationError, WorkflowSourceWatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { RunWaitListener } from "../events/runWaits.ts";
import type { AutomationRow } from "../WorkflowStore.ts";
import type { Watcher } from "./sourceWatches.ts";
import { scopeOf } from "./watch.ts";

/**
 * Everyone watching a source right now: live automations' triggers, and
 * running runs' `waitFor` steps.
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
        // Saving or switching it on again is someone new watching.
        id: `trigger:${automation.automation_id}@${automation.updated_at}`,
        scope: scopeOf(automation),
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
          scope: scopeOf(automation),
          watch,
          automation,
        });
    }
    return watchers;
  });
