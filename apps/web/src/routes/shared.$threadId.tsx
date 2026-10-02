import { createFileRoute } from "@tanstack/react-router";

import { validateSharedThreadSearch } from "../components/multiplayer/multiplayerModel";
import { SharedThreadPage } from "../components/multiplayer/SharedThreadPage";

function SharedThreadRoute() {
  const { threadId } = Route.useParams();
  const search = Route.useSearch();
  return <SharedThreadPage key={threadId} threadId={threadId} search={search} />;
}

export const Route = createFileRoute("/shared/$threadId")({
  validateSearch: validateSharedThreadSearch,
  component: SharedThreadRoute,
});
