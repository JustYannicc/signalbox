import { createFileRoute } from "@tanstack/react-router";

import { DiagnosticsSettingsPanel } from "../components/settings/DiagnosticsSettings";
import { SettingsPageCapability } from "../components/settings/SettingsCapability"; // signalbox

export const Route = createFileRoute("/settings/diagnostics")({
  component: () => (
    <SettingsPageCapability path="/settings/diagnostics">
      <DiagnosticsSettingsPanel />
    </SettingsPageCapability>
  ),
});
