import { createFileRoute } from "@tanstack/react-router";

import { PluginsPage } from "../components/plugins/PluginsPage";
import { parsePluginsSearch } from "../components/plugins/pluginsSearch";

function PluginsRoute() {
  return <PluginsPage search={Route.useSearch()} />;
}

export const Route = createFileRoute("/plugins")({
  validateSearch: parsePluginsSearch,
  component: PluginsRoute,
});
