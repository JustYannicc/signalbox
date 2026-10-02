import { createFileRoute } from "@tanstack/react-router";

import { ComputerPage } from "../components/computers/ComputerPage";

function ComputerRoute() {
  const { computerId } = Route.useParams();
  return <ComputerPage key={computerId} computerId={computerId} />;
}

export const Route = createFileRoute("/computers/$computerId")({
  component: ComputerRoute,
});
