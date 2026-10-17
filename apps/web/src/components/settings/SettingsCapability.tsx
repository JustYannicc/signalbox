import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useEnvironmentCapabilitiesKnown } from "~/state/environmentCapabilities";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { settingsItemGate, settingsPathGate } from "./settingsCapabilities";
import { useUnsupportedSettingsCapabilities } from "./useUnsupportedSettingsCapabilities";

/** Skip mounting controls whose requests the selected server cannot serve. */
export function SettingsCapability({ id, children }: { id: string; children: ReactNode }) {
  const scope = useOptionalSettingsScope();
  const unsupported = useUnsupportedSettingsCapabilities(
    id === "diagnostics" && scope?.environment
      ? { machine: scope.environment.environmentId }
      : scope?.search,
  );
  const configKnown = useEnvironmentCapabilitiesKnown();
  return settingsItemGate(id, unsupported, configKnown) === "show" ? children : null;
}

/** Saved links must follow the same capability policy as the Settings navigation. */
export function SettingsPageCapability({ path, children }: { path: string; children: ReactNode }) {
  const scope = useOptionalSettingsScope();
  const unsupported = useUnsupportedSettingsCapabilities(
    path === "/settings/diagnostics" && scope?.environment
      ? { machine: scope.environment.environmentId }
      : scope?.search,
  );
  const gate = settingsPathGate(path, unsupported, useEnvironmentCapabilitiesKnown());
  if (gate === "wait") return null;
  return gate === "show" ? children : <Navigate to="/settings/general" replace />;
}
