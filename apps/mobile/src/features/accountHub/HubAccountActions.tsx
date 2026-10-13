import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { UsageLimitSourceUpdateAccountInput } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { Alert, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** Pause, resume, or remove an account a hub pools. Adding accounts happens on web and desktop. */
export function HubAccountActions({ account }: { readonly account: LimitAccount }) {
  const update = useAtomCommand(serverEnvironment.updateUsageLimitSourceAccount, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState(false);
  const hub = account.hubAccount;
  if (!hub) return null;
  const name = account.email ?? account.displayName ?? "this account";

  const run = async (action: UsageLimitSourceUpdateAccountInput["action"]) => {
    setBusy(true);
    const result = await update({
      environmentId: hub.environmentId,
      input: { sourceId: hub.sourceId, accountId: hub.accountId, action },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      const failure = squashAtomCommandFailure(result);
      Alert.alert(
        `Could not ${action} ${name}`,
        failure instanceof Error ? failure.message : undefined,
      );
    }
  };

  const confirmRemove = () => {
    const title = `Remove ${name}?`;
    const message = "Work stops using this account. To use it again, add it again.";
    if (process.env.EXPO_OS === "ios") {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => void run("remove") },
      ]);
      return;
    }
    showConfirmDialog({
      title,
      message,
      confirmText: "Remove",
      destructive: true,
      onConfirm: () => void run("remove"),
    });
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Manage ${name}`}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={() =>
        Alert.alert(name, undefined, [
          // API keys have nothing to pause: the hub keeps them in its config.
          ...(hub.apiKey
            ? []
            : [
                {
                  text: hub.disabled ? "Resume" : "Pause",
                  onPress: () => void run(hub.disabled ? "resume" : "pause"),
                },
              ]),
          { text: "Remove", style: "destructive", onPress: confirmRemove },
          { text: "Cancel", style: "cancel" },
        ])
      }
      className="min-h-11 justify-center rounded-full bg-subtle-strong px-3"
    >
      <Text className="text-xs font-t3-medium text-foreground">Manage</Text>
    </Pressable>
  );
}
