import { StackActions, useNavigation } from "@react-navigation/native";
import { createNativeStackScreen } from "@react-navigation/native-stack";
import { useLayoutEffect } from "react";
import { Platform, Pressable } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useNeedsAccountSignIn } from "./accountGate";
import { AccountSignInScreen } from "./AccountSignInScreen";

/**
 * Home's content while nothing is connected. Signing in registers Signalbox
 * Cloud as the environment, which flips Home back to the thread list on its own.
 */
export function HomeAccountSignIn() {
  const navigation = useNavigation();

  // Full-bleed while signed out; Home's own branches set their header again,
  // but the iOS split-view branch only sets titles, so restore it on the way out.
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: false });
    return () => navigation.setOptions({ headerShown: true });
  }, [navigation]);

  return <AccountSignInScreen />;
}

/** Modal sign-in from "Add environment" (the pairing screen dev tooling still reaches). */
export function AccountSignInRouteScreen() {
  const navigation = useNavigation();

  return (
    <AccountSignInScreen
      onClose={() => navigation.goBack()}
      // Land on Home, where the new environment's threads show up.
      onSignedIn={() => navigation.dispatch(StackActions.popTo("Home"))}
    />
  );
}

/**
 * The root stack's `AccountSignIn` screen. No linking path: sign-in starts from
 * "Add environment", never from a link.
 */
export const accountSignInStackScreen = createNativeStackScreen({
  screen: AccountSignInRouteScreen,
  options: {
    headerShown: false,
    gestureEnabled: true,
    presentation: Platform.OS === "android" ? "card" : "modal",
  },
});

/** "Add environment" link to account sign-in. Hidden when sign-in is already Home. */
export function AccountSignInEntry() {
  const navigation = useNavigation();
  const needsSignIn = useNeedsAccountSignIn();
  if (needsSignIn) return null;

  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => navigation.navigate("AccountSignIn")}
      className="items-center self-center px-3 py-2 active:opacity-60"
    >
      <Text className="text-sm font-t3-medium text-foreground-muted">
        Sign in with an account instead
      </Text>
    </Pressable>
  );
}
