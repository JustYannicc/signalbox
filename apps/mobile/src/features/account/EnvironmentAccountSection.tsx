import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import type { AccountProfile } from "@t3tools/contracts/account";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";
import { Alert, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { environmentCatalog } from "../../connection/catalog";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "../settings/components/SettingsActionRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { fetchEnvironmentAccount, signOutAccount } from "./accountApi";

/**
 * The account behind an environment, with sign-out. Renders nothing for
 * environments connected by pairing code, relay, or before the server answers.
 */
export function EnvironmentAccountSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const navigation = useNavigation();
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, "environment remove");
  const prepared = Option.getOrNull(usePreparedConnection(props.environmentId));
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const httpBaseUrl = prepared?.httpBaseUrl ?? null;
  const token =
    prepared?.httpAuthorization?._tag === "Bearer" ? prepared.httpAuthorization.token : null;
  const [account, setAccount] = useState<AccountProfile | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    if (httpBaseUrl === null || token === null) return;
    let cancelled = false;
    fetchEnvironmentAccount(httpBaseUrl, token).then(
      (next) => {
        if (!cancelled) setAccount(next);
      },
      () => {
        // Keep the last answer; an offline server doesn't change who signed in.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [httpBaseUrl, token]);

  if (account === null) return null;

  const signOut = async () => {
    setSigningOut(true);
    try {
      // Best effort: the session is revoked when the server is reachable, and
      // the device forgets it either way.
      if (httpBaseUrl !== null && token !== null) {
        await signOutAccount(httpBaseUrl, token).catch(() => undefined);
      }
      const wasLast = catalog.entries.size <= 1;
      const removed = await removeEnvironment(props.environmentId);
      if (AsyncResult.isFailure(removed)) return;
      // With nothing left, Home is the sign-in screen.
      if (wasLast) navigation.dispatch(StackActions.popTo("Home"));
      else if (navigation.canGoBack()) navigation.goBack();
    } finally {
      setSigningOut(false);
    }
  };

  const name = [account.firstName, account.lastName].filter(Boolean).join(" ");

  return (
    <SettingsSection title="Account">
      <View className="gap-0.5 p-4">
        <Text className="text-base text-foreground" selectable>
          {name || account.email}
        </Text>
        {name ? (
          <Text className="text-sm text-foreground-muted" selectable>
            {account.email}
          </Text>
        ) : null}
      </View>
      <SettingsActionRow
        icon={{ ios: "rectangle.portrait.and.arrow.right", android: "lock" }}
        label="Sign out"
        tone="danger"
        disabled={signingOut}
        loading={signingOut}
        onPress={() =>
          Alert.alert(
            `Sign out of ${props.environmentLabel}?`,
            "This removes it and its cached threads from this device. Sign in again to get them back.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Sign out", style: "destructive", onPress: () => void signOut() },
            ],
          )
        }
      />
    </SettingsSection>
  );
}
