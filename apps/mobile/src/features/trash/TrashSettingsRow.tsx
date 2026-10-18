import { useTrashEnvironments } from "../../state/signalboxTrash";
import { SettingsRow } from "../settings/components/SettingsRow";

/** Settings' way into Trash, where an environment keeps one. */
export function TrashSettingsRow() {
  return useTrashEnvironments().length === 0 ? null : (
    <SettingsRow icon="trash" label="Trash" target="SettingsTrash" />
  );
}
