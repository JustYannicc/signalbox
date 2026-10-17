import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppState, Linking } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { runtime } from "../../lib/runtime";
import { supportsAgentAwarenessPush } from "../agent-awareness/capabilities";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { refreshAgentAwarenessRegistration } from "../agent-awareness/remoteRegistration";
import {
  getSignalboxCloudPushStatus,
  subscribeSignalboxCloudPushStatus,
} from "../agent-awareness/signalboxCloudPush";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/** Cloud accounts register directly; the self-hosted Connect screen stays separate. */
export function SettingsSignalboxNotificationsRouteScreen() {
  const insets = useSafeAreaInsets();
  const registration = useSyncExternalStore(
    subscribeSignalboxCloudPushStatus,
    getSignalboxCloudPushStatus,
    () => "unknown" as const,
  );
  const [permission, setPermission] = useState<"checking" | "enabled" | "disabled">("checking");
  const [busy, setBusy] = useState(false);
  const pushAvailable = supportsAgentAwarenessPush();

  const refresh = useCallback(async () => {
    try {
      const result = await Notifications.getPermissionsAsync();
      setPermission(result.granted ? "enabled" : "disabled");
      await runtime.runPromise(refreshAgentAwarenessRegistration());
    } catch {
      setPermission("disabled");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const openSystemSettings = () => {
    void Linking.openSettings().catch(() => {
      Dialog.alert("Couldn't open Settings", "Open system Settings, then select Signalbox.");
    });
  };

  const enableNotifications = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await runtime.runPromise(requestAgentNotificationPermission);
      if (result.type === "granted") {
        setPermission("enabled");
        await runtime.runPromise(refreshAgentAwarenessRegistration());
        if (getSignalboxCloudPushStatus() !== "registered") {
          Dialog.alert(
            "Couldn't enable notifications",
            "Notification access is on, but this phone couldn't register with Signalbox. Try again.",
          );
        }
      } else {
        setPermission("disabled");
        await runtime.runPromise(refreshAgentAwarenessRegistration());
        if (result.type === "denied" && !result.canAskAgain) {
          Dialog.alert(
            "Notifications are off",
            "Enable notifications for Signalbox in system Settings.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open Settings", onPress: openSystemSettings },
            ],
          );
        }
      }
    } catch {
      Dialog.alert("Couldn't enable notifications", "Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const registered = registration === "registered";
  const subtitle = !pushAvailable
    ? "This app build does not support push notifications"
    : permission === "checking"
      ? "Checking notification access…"
      : permission === "disabled"
        ? "Off in system Settings"
        : registered
          ? "Questions, approvals and updates that need you"
          : registration === "pending"
            ? "Setting up notifications…"
            : "Couldn't register this phone. Turn on to retry.";

  return (
    <SettingsScreen title="Notifications">
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Agent activity">
          <SettingsSwitchRow
            icon="bell.badge"
            label="Device Notifications"
            subtitle={subtitle}
            disabled={!pushAvailable || busy || permission === "checking"}
            value={pushAvailable && permission === "enabled" && registered}
            onValueChange={(enabled) => {
              if (enabled) void enableNotifications();
              else openSystemSettings();
            }}
          />
          <SettingsRow
            icon="gearshape"
            label="System Notification Settings"
            onPress={openSystemSettings}
          />
        </SettingsSection>
      </ScreenScrollView>
    </SettingsScreen>
  );
}
