import { createFileRoute, Navigate } from "@tanstack/react-router";

import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";
import { useShowsEnvironmentUi } from "../state/environmentCapabilities";

// signalbox: with one environment there is nothing to connect.
function ConnectionsRoute() {
  return useShowsEnvironmentUi() ? (
    <ConnectionsSettings />
  ) : (
    <Navigate to="/settings/general" replace />
  );
}

export const Route = createFileRoute("/settings/connections")({
  component: ConnectionsRoute,
});
