import { useAnyEnvironmentSupports } from "../../state/environmentCapabilities";
import { SettingsRow } from "../settings/components/SettingsRow";
import { useOpenAutomationsFromSettings } from "./navigation";

/** Settings' ways into Automations and the services they reach, beside Scheduled tasks. */
export function AutomationsSettingsRows() {
  const openAutomations = useOpenAutomationsFromSettings();
  const connectsServices = useAnyEnvironmentSupports("connectedServices");
  return (
    <>
      <SettingsRow icon="bolt.circle" label="Automations" onPress={openAutomations} />
      {connectsServices ? (
        <SettingsRow icon="link" label="Connected services" target="SettingsConnectedServices" />
      ) : null}
    </>
  );
}
