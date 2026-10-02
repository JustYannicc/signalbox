import { createFileRoute } from "@tanstack/react-router";

import { NotificationSettingsPage } from "../components/settings/NotificationSettingsPage";

function SettingsNotificationsRoute() {
  return <NotificationSettingsPage />;
}

export const Route = createFileRoute("/settings/notifications")({
  component: SettingsNotificationsRoute,
});
