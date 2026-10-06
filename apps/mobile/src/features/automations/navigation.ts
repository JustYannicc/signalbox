import {
  CommonActions,
  useNavigation,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import { useCallback } from "react";

/**
 * Opens Automations from inside the Settings sheet. Automations are a
 * workspace destination (they push threads and runs), so the sheet closes and
 * Automations lands on the workspace stack in the same update.
 */
export function useOpenAutomationsFromSettings() {
  const navigation = useNavigation();
  return useCallback(() => {
    let root: NavigationProp<ParamListBase> | undefined = navigation.getParent();
    while (root?.getParent()) root = root.getParent();
    (root ?? navigation).dispatch((state) => {
      const sheet = state.routes.findIndex((route) => route.name === "SettingsSheet");
      const routes = sheet < 0 ? state.routes : state.routes.slice(0, sheet);
      return CommonActions.reset({
        ...state,
        routes: [...routes, { key: `Automations-${Date.now()}`, name: "Automations" }],
        index: routes.length,
      });
    });
  }, [navigation]);
}
