import { createFileRoute } from "@tanstack/react-router";

import { LevelCostsPage } from "../components/usage/LevelCostsPage";

// signalbox: Usage › Costs, spend rolled up the Home tree. `level` is the folder you're in.
function CostsRoute() {
  return <LevelCostsPage level={Route.useSearch().level} />;
}

export const Route = createFileRoute("/costs")({
  validateSearch: (search: Record<string, unknown>): { level?: string } =>
    typeof search.level === "string" && search.level.length > 0 ? { level: search.level } : {},
  component: CostsRoute,
});
