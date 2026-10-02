import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { AutomationPage } from "../components/automations/AutomationPage";

const isRunId = Schema.is(Schema.NonEmptyString);

export interface AutomationRouteSearch {
  /** A run: opens its chat, or its step results on the canvas with `show=workflow`. */
  run?: string;
  show?: "workflow";
}

function AutomationRoute() {
  const { automationId } = Route.useParams();
  const { run, show } = Route.useSearch();
  return (
    <AutomationPage
      key={automationId}
      automationId={automationId}
      runId={run ?? null}
      showRunOnWorkflow={show === "workflow"}
    />
  );
}

export const Route = createFileRoute("/automations/$automationId")({
  validateSearch: (raw: Record<string, unknown>): AutomationRouteSearch => ({
    ...(isRunId(raw.run) ? { run: raw.run } : {}),
    ...(raw.show === "workflow" ? { show: "workflow" as const } : {}),
  }),
  component: AutomationRoute,
});
