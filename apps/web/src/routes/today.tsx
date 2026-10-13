import { createFileRoute } from "@tanstack/react-router";

import { TopLayerPage, validateTopLayerSearch } from "../components/toplayer/TopLayerPage";

// Fork: the top layer (issue #180), what the app opens on.
export const Route = createFileRoute("/today")({
  validateSearch: validateTopLayerSearch,
  component: TopLayerPage,
});
