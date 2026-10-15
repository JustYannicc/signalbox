import { createFileRoute } from "@tanstack/react-router";

import {
  AutomationsOverviewPage,
  overviewViewSearch,
} from "../components/automations/AutomationsOverviewPage";

/** `?view=all` lists every automation and `?view=steps` every trigger and step, instead of what needs you. */
export type AutomationsSearch = ReturnType<typeof overviewViewSearch>;

function AutomationsRoute() {
  const { view } = Route.useSearch();
  return <AutomationsOverviewPage view={view ?? "needsYou"} />;
}

export const Route = createFileRoute("/_chat/automations/")({
  validateSearch: (search: Record<string, unknown>): AutomationsSearch =>
    overviewViewSearch(search.view),
  component: AutomationsRoute,
});
