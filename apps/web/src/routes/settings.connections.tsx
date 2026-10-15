import { createFileRoute, Navigate } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";
import { useEnvironmentUiState } from "../state/environmentCapabilities";

// signalbox: with one environment there is nothing to connect.
function ConnectionsRoute() {
  const state = useEnvironmentUiState();
  if (state === "unknown") return null;
  return state === "shown" ? <ConnectionsSettings /> : <Navigate to="/settings/general" replace />;
}

export const Route = createFileRoute("/settings/connections")({
  component: ConnectionsRoute,
});
