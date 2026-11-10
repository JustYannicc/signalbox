import { useAnyEnvironmentSupports } from "../../state/environmentCapabilities";
import { useFolderEnvironments } from "../../state/signalboxFolders";
import { SettingsRow } from "../settings/components/SettingsRow";
import { useOpenAutomationsFromSettings } from "./navigation";

/** Settings' ways into Automations, the services they reach and the blocks they call, beside Scheduled tasks. */
export function AutomationsSettingsRows() {
  const openAutomations = useOpenAutomationsFromSettings();
  const connectsServices = useAnyEnvironmentSupports("connectedServices");
  // Blocks resolve along folders, so only environments that keep folders have a library.
  const keepsFolders = useFolderEnvironments().length > 0;
  return (
    <>
      <SettingsRow icon="bolt.circle" label="Automations" onPress={openAutomations} />
      {connectsServices ? (
        <SettingsRow icon="link" label="Connected services" target="SettingsConnectedServices" />
      ) : null}
      {keepsFolders ? (
        <SettingsRow
          icon="square.3.layers.3d"
          label="Block library"
          target="SettingsAutomationBlocks"
        />
      ) : null}
    </>
  );
}
