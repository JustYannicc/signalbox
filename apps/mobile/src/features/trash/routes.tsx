import { createNativeStackScreen } from "@react-navigation/native-stack";

import { SettingsTrashRouteScreen } from "./SettingsTrashRouteScreen";

/** Settings-sheet routes for Trash (#474). */
export function trashSettingsScreens() {
  return {
    SettingsTrash: createNativeStackScreen({
      screen: SettingsTrashRouteScreen,
      linking: "trash",
      options: { title: "Trash" },
    }),
  };
}
