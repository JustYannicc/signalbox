import { createFileRoute } from "@tanstack/react-router";

import { AutomationsOverviewPage } from "../components/automations/AutomationsOverviewPage";

/** `?view=steps` shows every trigger and step instead of what needs you. */
export interface AutomationsSearch {
  readonly view?: "steps";
}

function AutomationsRoute() {
  const { view } = Route.useSearch();
  return <AutomationsOverviewPage view={view === "steps" ? "steps" : "needsYou"} />;
}

export const Route = createFileRoute("/_chat/automations/")({
  validateSearch: (search: Record<string, unknown>): AutomationsSearch =>
    search.view === "steps" ? { view: "steps" } : {},
  component: AutomationsRoute,
});
