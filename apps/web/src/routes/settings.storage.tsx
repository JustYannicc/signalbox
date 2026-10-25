import { createFileRoute } from "@tanstack/react-router";
import { StorageSettingsPanel } from "../components/settings/StorageSettings";
import { SettingsPageCapability } from "../components/settings/SettingsCapability"; // signalbox

export const Route = createFileRoute("/settings/storage")({
  component: () => (
    <SettingsPageCapability path="/settings/storage">
      <StorageSettingsPanel />
    </SettingsPageCapability>
  ),
});
