import { automationKey } from "@t3tools/client-runtime/automations/list";
import type { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { AutomationPage } from "../components/automations/AutomationPage";
import { AutomationView } from "../components/automations/automationFormat";

/**
 * `?run=` picks a run, which opens as its chat; `?view=diagram` draws it on the
 * diagram instead and `?view=code&line=` opens the source at a line. Without a
 * run the diagram shows the latest one.
 */
export interface AutomationSearch {
  readonly run?: string;
  readonly view?: AutomationView;
  readonly line?: number;
}

const isAutomationView = Schema.is(AutomationView);

function validateAutomationSearch(search: Record<string, unknown>): AutomationSearch {
  const line = Number(search.line);
  return {
    ...(typeof search.run === "string" && search.run ? { run: search.run } : {}),
    ...(isAutomationView(search.view) ? { view: search.view } : {}),
    ...(Number.isInteger(line) && line > 0 ? { line } : {}),
  };
}

function AutomationRoute() {
  const { environmentId, automationId } = Route.useParams();
  const search = Route.useSearch();
  return (
    <AutomationPage
      // Each automation starts fresh: selection, fit and run attention don't carry over.
      key={automationKey(environmentId, automationId)}
      environmentId={environmentId as EnvironmentId}
      automationId={automationId}
      runId={search.run ?? null}
      view={search.view ?? (search.run ? "run" : "diagram")}
      line={search.line ?? null}
    />
  );
}

export const Route = createFileRoute("/_chat/automations/$environmentId/$automationId")({
  validateSearch: validateAutomationSearch,
  component: AutomationRoute,
});
