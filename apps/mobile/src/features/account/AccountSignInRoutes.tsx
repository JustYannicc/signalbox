import { StackActions, useNavigation } from "@react-navigation/native";
import { createNativeStackScreen } from "@react-navigation/native-stack";
import { useLayoutEffect } from "react";
import { Platform, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { useNeedsAccountSignIn } from "./accountGate";
import { AccountSignInScreen } from "./AccountSignInScreen";

/** Prefills the pairing form's host so "pair instead" doesn't mean retyping it. */
function usePrefillPairingHost() {
  const { onChangeConnectionPairingUrl } = useRemoteConnections();
  return (serverUrl: string | null) => {
    if (serverUrl !== null) onChangeConnectionPairingUrl(serverUrl);
  };
}

/**
 * Home's content while nothing is connected. Signing in or pairing registers
 * an environment, which flips Home back to the thread list on its own.
 */
export function HomeAccountSignIn() {
  const navigation = useNavigation();
  const prefillPairingHost = usePrefillPairingHost();

  // Full-bleed while signed out; Home's own branches set their header again,
  // but the iOS split-view branch only sets titles, so restore it on the way out.
  useLayoutEffect(() => {
    navigation.setOptions({ headerShown: false });
    return () => navigation.setOptions({ headerShown: true });
  }, [navigation]);

  return (
    <AccountSignInScreen
      onPairInstead={(serverUrl) => {
        prefillPairingHost(serverUrl);
        navigation.navigate("ConnectionsNew");
      }}
    />
  );
}

/** Modal sign-in for adding another environment from "Add environment". */
export function AccountSignInRouteScreen() {
  const navigation = useNavigation();
  const prefillPairingHost = usePrefillPairingHost();

  return (
    <AccountSignInScreen
      onClose={() => navigation.goBack()}
      // Land on Home, where the new environment's threads show up.
      onSignedIn={() => navigation.dispatch(StackActions.popTo("Home"))}
      onPairInstead={(serverUrl) => {
        prefillPairingHost(serverUrl);
        // "Add environment" opened this sheet; its pairing form is underneath.
        navigation.goBack();
      }}
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
