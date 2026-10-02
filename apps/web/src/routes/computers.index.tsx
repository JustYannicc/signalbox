import { createFileRoute } from "@tanstack/react-router";

import { ComputersIndexPage } from "../components/computers/ComputersIndexPage";

export const Route = createFileRoute("/computers/")({
  component: ComputersIndexPage,
});
