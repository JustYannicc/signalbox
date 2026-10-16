import { createNativeStackScreen } from "@react-navigation/native-stack";

import { SettingsSignInRouteScreen } from "./SettingsSignInRouteScreen";

/** Settings-sheet routes for standing sign-in grants (#575). */
export function signInSettingsScreens() {
  return {
    SettingsSignIn: createNativeStackScreen({
      screen: SettingsSignInRouteScreen,
      linking: "sign-in",
      options: { title: "Signing in" },
    }),
  };
}
