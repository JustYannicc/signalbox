import { useMemo } from "react";

import { useShowsEnvironmentUi } from "~/state/environmentCapabilities";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { resolveSettingsScope, type SettingsScopeSearch } from "./settingsScope";
import { unsupportedSettingsCapabilities } from "./settingsSearch";
import { useSettingsProjectGroups } from "./useSettingsProjectGroups";

const EMPTY_SCOPE_SEARCH: SettingsScopeSearch = {};

/** Capabilities absent from every environment in the selected settings scope. */
export function useUnsupportedSettingsCapabilities(
  scopeSearch: SettingsScopeSearch = EMPTY_SCOPE_SEARCH,
) {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const showsEnvironmentUi = useShowsEnvironmentUi();
  const groups = useSettingsProjectGroups();
  return useMemo(() => {
    const scope = resolveSettingsScope(scopeSearch, groups, environments);
    const unsupported = unsupportedSettingsCapabilities(
      environments.filter((environment) =>
        scope.environmentIds.includes(environment.environmentId),
      ),
      primaryEnvironment,
    );
    // The same rule as everywhere else, including a desktop gateway before it signs in.
    return showsEnvironmentUi
      ? unsupported
      : new Set([...unsupported, "otherEnvironments" as const]);
  }, [environments, groups, primaryEnvironment, scopeSearch, showsEnvironmentUi]);
}
