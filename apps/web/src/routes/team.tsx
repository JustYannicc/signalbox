import { createFileRoute } from "@tanstack/react-router";

import { TeamPage } from "../components/team/TeamPage";

export const Route = createFileRoute("/team")({
  component: TeamPage,
});
