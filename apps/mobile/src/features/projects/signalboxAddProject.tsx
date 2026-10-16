/**
 * signalbox: Add project on environments that are still connecting or that
 * lack parts of a self-hosted server (Signalbox Cloud).
 */
import {
  type AddProjectAvailability,
  resolveAddProjectAvailability,
} from "@t3tools/client-runtime/operations/signalboxAddProject";
import { useMemo } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import {
  useRemoteConnectionStatus,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { useShowsEnvironmentUi } from "../../state/environmentCapabilities";

/** Whether Add project can start, is waiting on a connection, or needs one connected. */
export function useAddProjectAvailability(): AddProjectAvailability {
  const { isLoadingSavedConnection } = useSavedRemoteConnections();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  return useMemo(
    () =>
      resolveAddProjectAvailability({
        catalogReady: isLoadingSavedConnection !== true,
        phases: connectedEnvironments.map((environment) => environment.connectionState),
      }),
    [connectedEnvironments, isLoadingSavedConnection],
  );
}

/** Shown in place of the environment picker until one connects; the screen continues on its own. */
export function ConnectingEnvironmentState() {
  const showsEnvironments = useShowsEnvironmentUi();
  return (
    <View className="items-center gap-3 rounded-2xl bg-grouped-card px-5 py-8">
      <AppActivityIndicator colorClassName="accent-icon-muted" />
      <Text className="text-center text-lg font-t3-bold">Connecting</Text>
      <Text className="text-center text-sm leading-normal text-foreground-muted">
        {showsEnvironments
          ? "Your environment is on its way. Add project continues once it connects."
          : "Signalbox is connecting. Add project continues once it does."}
      </Text>
    </View>
  );
}

/** Signalbox Cloud is the only environment and it isn't reachable: nothing to add, just wait. */
export function SignalboxUnavailableState() {
  return (
    <View className="items-center gap-3 rounded-2xl bg-grouped-card px-5 py-8">
      <Text className="text-center text-lg font-t3-bold">Can't reach Signalbox</Text>
      <Text className="text-center text-sm leading-normal text-foreground-muted">
        Check your connection. Add project continues once Signalbox is back.
      </Text>
    </View>
  );
}
