import type { NavigationProp } from "@react-navigation/native";

import type { CommandPaletteItem } from "../keyboard/commandPaletteItems";

/** Automations' entries in the command palette: the list, the services `w.call` reaches and the blocks `w.start` calls. */
export function automationPaletteActions(
  navigation: Pick<NavigationProp<ReactNavigation.RootParamList>, "navigate">,
): CommandPaletteItem[] {
  return [
    {
      key: "automations",
      kind: "action",
      title: "Automations",
      searchTerms: ["workflows", "runs", "waiting"],
      run: () => navigation.navigate("Automations"),
    },
    {
      key: "connectedServices",
      kind: "action",
      title: "Connected services",
      searchTerms: ["executor", "accounts", "automations", "gmail", "github"],
      run: () =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsConnectedServices" },
        }),
    },
    {
      key: "blockLibrary",
      kind: "action",
      title: "Block library",
      searchTerms: ["blocks", "automations", "w.start", "contracts"],
      run: () =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsAutomationBlocks" },
        }),
    },
  ];
}
