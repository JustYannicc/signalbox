import { AutomationBuiltIn } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { builtInId, type BuiltInAutomation } from "../defaults/registry.ts";
import { outlineGraph } from "../outline.ts";
import type { CatalogShape } from "../catalog.ts";
import type { ReadResult } from "./summaries.ts";

/** Built-ins as automation_list and automation_read show them before they run in a project. */

export const BuiltInListEntry = AutomationBuiltIn.annotate({
  description:
    "A built-in automation. Run it with automation_run by this id (attach it to a thread, or pass projectId); automation_customize makes it the project's own to edit.",
});

export const BuiltInList = Schema.Array(BuiltInListEntry);

/** automation_read for `builtin:<slug>`: its code and diagram, no runs. */
export function builtInReadResult(
  builtIn: BuiltInAutomation,
  validate: CatalogShape["validate"],
): typeof ReadResult.Type {
  const compiled = validate(builtIn.source);
  return {
    automation: {
      automationId: builtInId(builtIn),
      name: builtIn.name,
      description: builtIn.description,
      projectId: "",
      enabled: true,
      version: 0,
      draftVersion: null,
      triggers: [],
      nextRunAt: null,
      webhook: null,
      lastRun: null,
      builtIn: true,
    },
    intent: null,
    source: builtIn.source,
    outline: compiled.ok ? outlineGraph(compiled.graph) : "",
    draft: null,
    runs: [],
    webhookRejections: [],
  };
}
