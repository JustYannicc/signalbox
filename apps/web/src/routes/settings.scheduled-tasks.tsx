import { createFileRoute } from "@tanstack/react-router";
import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";

import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";
import { SettingsPageCapability } from "../components/settings/SettingsCapability"; // signalbox

function SettingsScheduledTasksRoute() {
  const target = Route.useSearch();
  return (
    <SettingsPageCapability path="/settings/scheduled-tasks">
      <ScheduledTasksSettings {...target} />
    </SettingsPageCapability>
  );
}

export const Route = createFileRoute("/settings/scheduled-tasks")({
  validateSearch: validateScheduledTasksSearch,
  component: SettingsScheduledTasksRoute,
});
