import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";

import { usePrimaryCloudLinkState } from "~/cloud/primaryCloudLinkState";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { isElectron } from "~/env";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { isLocalEnvironmentAvailable } from "~/account/cloudDefault";
import { useShowsEnvironmentUi } from "~/state/environmentCapabilities";
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
  const showsEnvironmentUi = useShowsEnvironmentUi();
  const machine = scopeSearch.machine;
  const unsupported = unsupportedSettingsCapabilities(
    environments.filter(
      (environment) => machine === undefined || environment.environmentId === machine,
    ),
    primaryEnvironment,
  );
  // The same rule as everywhere else, including a desktop gateway before it signs in.
  return showsEnvironmentUi ? unsupported : new Set([...unsupported, "otherEnvironments" as const]);
}

export function useAvailableSettingsSearchItems(scopeSearch: SettingsScopeSearch = {}) {
  const { environments } = useEnvironments();
  // The filtered list must be cached on boolean flags so it stays stable for the search and
  // the command palette while environments update. The compiler cannot tell that `.some()`
  // and other plain calls return primitives, so `=== true` marks each flag as one; without
  // it the flags join the filter's cache scope and the list is rebuilt every render.
  const hasEnvironment =
    environments.some((environment) => environment.serverConfig !== null) === true;
  const hasProviderSettingsEnvironment =
    environments.some((environment) =>
      isProviderSettingsEnvironmentAvailable({
        connectionPhase: environment.connection.phase,
        hasServerConfig: environment.serverConfig !== null,
      }),
    ) === true;
  const hasMacProviderSettingsEnvironment =
    environments.some(
      (environment) =>
        (scopeSearch.machine === undefined || environment.environmentId === scopeSearch.machine) &&
        environment.serverConfig?.environment.platform.os === "darwin" &&
        isProviderSettingsEnvironmentAvailable({
          connectionPhase: environment.connection.phase,
          hasServerConfig: true,
        }),
    ) === true;
  const hasThreadAutoSettlement =
    getThreadAutoSettlementSearchAvailability(environments).eligibleEnvironmentIds.length > 0;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const unsupportedCapabilities = useUnsupportedSettingsCapabilities(scopeSearch);
  const canMaintain = useEnvironmentScope(primaryEnvironmentId, AuthEnvironmentMaintainScope);
  const cloudLinkState = usePrimaryCloudLinkState().data;
  // Same fallback as the Connections row: older servers imply a tunnel from `linked`.
  const managedTunnelActive =
    cloudLinkState?.linkRevoked !== true &&
    (cloudLinkState?.managedTunnelActive ?? cloudLinkState?.linked ?? false) === true;
  const localEnvironmentDisabled = isLocalEnvironmentDisabled() === true;
  const canManageLocalBackend = !localEnvironmentDisabled && canMaintain;
  const desktopWsl = useEnvironmentQuery(
    isElectron && canManageLocalBackend ? desktopWslStateAtom : null,
  );
  const cloudPublicConfig = hasCloudPublicConfig() === true;
  const wslSettingsRowVisible =
    isWslSettingsRowVisible({ state: desktopWsl.data, error: desktopWsl.error }) === true;

  return filterAvailableSettingsSearchItems({
    localEnvironmentDisabled,
    hasCloudPublicConfig: cloudPublicConfig,
    hasEnvironment,
    hasProviderSettingsEnvironment,
    hasMacProviderSettingsEnvironment,
    canManageLocalBackend,
    isWslSettingsRowVisible: wslSettingsRowVisible,
    hasThreadAutoSettlement,
    managedTunnelActive,
    unsupportedCapabilities,
    // signalbox: the thin cloud build has no local server to turn on.
  })
    .filter((item) => item.id !== "local-environment" || isLocalEnvironmentAvailable())
    .filter((item) => item.id !== "mobile-app"); // signalbox: no store app, so no Mobile app row
}
