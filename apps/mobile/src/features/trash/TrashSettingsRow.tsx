import { useTrashEnvironmentId } from "../../state/signalboxTrash";
import { SettingsRow } from "../settings/components/SettingsRow";

/** Settings' way into Trash, where an environment keeps one. */
export function TrashSettingsRow() {
  return useTrashEnvironmentId() === null ? null : (
    <SettingsRow icon="trash" label="Trash" target="SettingsTrash" />
  );
}
