import { useMemo } from "react";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";

import { usePrimaryCloudLinkState } from "~/cloud/primaryCloudLinkState";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { isLocalEnvironmentAvailable } from "~/account/cloudDefault";
import { desktopWslStateAtom } from "~/state/desktopWslState";
import {
  useEnvironments,
  usePrimaryEnvironment,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import { isWslSettingsRowVisible } from "./ConnectionsSettings.logic";
import { isProviderSettingsEnvironmentAvailable } from "./ProviderSettingsPanel.logic";
import type { SettingsScopeSearch } from "./settingsScope";
import {
  filterAvailableSettingsSearchItems,
  getThreadAutoSettlementSearchAvailability,
  unsupportedSettingsCapabilities,
} from "./settingsSearch";

/** signalbox: capabilities no environment the settings act on has, within the machine filter. */
export function useUnsupportedSettingsCapabilities(scopeSearch: SettingsScopeSearch = {}) {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  return useMemo(
    () =>
      unsupportedSettingsCapabilities(
        environments.filter(
          (environment) =>
            scopeSearch.machine === undefined || environment.environmentId === scopeSearch.machine,
        ),
        primaryEnvironment,
      ),
    [environments, primaryEnvironment, scopeSearch.machine],
  );
}

export function useAvailableSettingsSearchItems(scopeSearch: SettingsScopeSearch = {}) {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const unsupportedCapabilities = useUnsupportedSettingsCapabilities(scopeSearch);
  const localEnvironmentDisabled = isLocalEnvironmentDisabled();
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const canManageLocalBackend = !localEnvironmentDisabled && canMaintain;
  const desktopWsl = useEnvironmentQuery(
    isElectron && canManageLocalBackend ? desktopWslStateAtom : null,
  );
  const cloudLinkState = usePrimaryCloudLinkState().data;
  // Same fallback as the Connections row: older servers imply a tunnel from `linked`.
  const managedTunnelActive =
    cloudLinkState?.linkRevoked !== true &&
    (cloudLinkState?.managedTunnelActive ?? cloudLinkState?.linked ?? false);

  return useMemo(
    () =>
      filterAvailableSettingsSearchItems({
        localEnvironmentDisabled,
        hasCloudPublicConfig: hasCloudPublicConfig(),
        hasEnvironment: environments.some((environment) => environment.serverConfig !== null),
        hasProviderSettingsEnvironment: environments.some((environment) =>
          isProviderSettingsEnvironmentAvailable({
            connectionPhase: environment.connection.phase,
            hasServerConfig: environment.serverConfig !== null,
          }),
        ),
        hasMacProviderSettingsEnvironment: environments.some(
          (environment) =>
            (scopeSearch.machine === undefined ||
              environment.environmentId === scopeSearch.machine) &&
            environment.serverConfig?.environment.platform.os === "darwin" &&
            isProviderSettingsEnvironmentAvailable({
              connectionPhase: environment.connection.phase,
              hasServerConfig: true,
            }),
        ),
        canManageLocalBackend,
        isWslSettingsRowVisible: isWslSettingsRowVisible({
          state: desktopWsl.data,
          error: desktopWsl.error,
        }),
        hasThreadAutoSettlement:
          getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0,
        managedTunnelActive,
        unsupportedCapabilities,
        // signalbox: the thin cloud build has no local server to turn on.
      }).filter((item) => item.id !== "local-environment" || isLocalEnvironmentAvailable()),
    [
      managedTunnelActive,
      unsupportedCapabilities,
      canManageLocalBackend,
      desktopWsl.data,
      desktopWsl.error,
      environments,
      localEnvironmentDisabled,
      scopeSearch.machine,
    ],
  );
}
