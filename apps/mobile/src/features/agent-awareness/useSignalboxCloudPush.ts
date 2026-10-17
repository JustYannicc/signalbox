import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";

import { runtime } from "../../lib/runtime";
import { environmentServerConfigsAtom } from "../../state/server";
import { savedConnectionsByIdAtom } from "../../state/use-remote-environment-registry";
import { requestAgentNotificationPermission } from "./notificationPermissions";
import { registerAgentAwarenessForSignalboxCloud } from "./remoteRegistration";
import {
  resetSignalboxCloudPushStatus,
  signalboxCloudIds,
  signalboxCloudPushIdentity,
} from "./signalboxCloudPush";

/**
 * signalbox: once a Signalbox Cloud connects, asks for notification permission
 * (the system asks only once) and registers this phone for its pushes, keeping
 * the registration current from then on (token rotation, foreground). Without
 * permission the cloud forgets the phone.
 */
export function useSignalboxCloudPush(): void {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const connections = useAtomValue(savedConnectionsByIdAtom);
  const identity = signalboxCloudPushIdentity(configs, connections);
  const hasCloud = signalboxCloudIds(configs).length > 0;
  useEffect(() => {
    resetSignalboxCloudPushStatus(identity);
    if (!hasCloud) return;
    let active = true;
    void runtime.runPromise(requestAgentNotificationPermission.pipe(Effect.ignore)).then(() => {
      if (active) registerAgentAwarenessForSignalboxCloud();
    });
    // Connect owns its own listener lifecycle and can sign out independently.
    const foreground = AppState.addEventListener("change", (state) => {
      if (state === "active") registerAgentAwarenessForSignalboxCloud();
    });
    const token = Notifications.addPushTokenListener((value) => {
      if (value.type === Platform.OS && typeof value.data === "string" && value.data.trim()) {
        registerAgentAwarenessForSignalboxCloud({ observedPushToken: value.data.trim() });
      }
    });
    return () => {
      active = false;
      foreground.remove();
      token.remove();
    };
  }, [identity, hasCloud]);
}
