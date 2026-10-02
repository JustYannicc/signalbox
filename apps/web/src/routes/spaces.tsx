import { createFileRoute } from "@tanstack/react-router";

import { SpacesPage } from "../components/spaces/SpacesPage";
import { validateSpacesSearch } from "../components/spaces/spacesModel";

export const Route = createFileRoute("/spaces")({
  validateSearch: validateSpacesSearch,
  component: SpacesPage,
});
