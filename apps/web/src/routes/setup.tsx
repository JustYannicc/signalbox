import { createFileRoute } from "@tanstack/react-router";

import { SetupPage } from "../components/setup/SetupPage";

export const Route = createFileRoute("/setup")({
  component: SetupPage,
});
