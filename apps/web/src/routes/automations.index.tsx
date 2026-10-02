import { createFileRoute } from "@tanstack/react-router";

import { AutomationsOverviewPage } from "../components/automations/AutomationsOverviewPage";

export interface AutomationsIndexSearch {
  /** `primitives` shows the reference of every hook and step instead of the list. */
  view?: "primitives";
}

function AutomationsIndexRoute() {
  const { view } = Route.useSearch();
  return <AutomationsOverviewPage view={view ?? "automations"} />;
}

export const Route = createFileRoute("/automations/")({
  validateSearch: (raw: Record<string, unknown>): AutomationsIndexSearch =>
    raw.view === "primitives" ? { view: "primitives" } : {},
  component: AutomationsIndexRoute,
});
