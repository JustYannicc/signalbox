import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { useEffect } from "react";

import { runtime } from "../../lib/runtime";
import { environmentServerConfigsAtom } from "../../state/server";
import { requestAgentNotificationPermission } from "./notificationPermissions";
import { registerAgentAwarenessForSignalboxCloud } from "./remoteRegistration";
import { signalboxCloudIds } from "./signalboxCloudPush";

/**
 * signalbox: once a Signalbox Cloud connects, asks for notification permission
 * (the system asks only once) and registers this phone for its pushes, keeping
 * the registration current from then on (token rotation, foreground). Without
 * permission the cloud forgets the phone.
 */
export function useSignalboxCloudPush(): void {
  const clouds = signalboxCloudIds(useAtomValue(environmentServerConfigsAtom)).join(",");
  useEffect(() => {
    if (clouds.length === 0) return;
    void runtime
      .runPromise(requestAgentNotificationPermission.pipe(Effect.ignore))
      .then(registerAgentAwarenessForSignalboxCloud);
  }, [clouds]);
}
