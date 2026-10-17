import { Navigate, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useEnvironmentUiState } from "~/state/environmentCapabilities";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { settingsItemGate, settingsPathGate } from "./settingsCapabilities";
import { useUnsupportedSettingsCapabilities } from "./useAvailableSettingsSearchItems";

/** Skip mounting controls whose requests the selected server cannot serve. */
export function SettingsCapability({ id, children }: { id: string; children: ReactNode }) {
  const scope = useOptionalSettingsScope();
  const unsupported = useUnsupportedSettingsCapabilities(
    id === "diagnostics" && scope?.environment
      ? { machine: scope.environment.environmentId }
      : scope?.search,
  );
  const configKnown = useEnvironmentUiState() !== "unknown";
  return settingsItemGate(id, unsupported, configKnown) === "show" ? children : null;
}

/** Saved links must follow the same capability policy as the Settings navigation. */
export function SettingsCapabilityBoundary({ children }: { children: ReactNode }) {
  const scope = useOptionalSettingsScope();
  const pathname = useLocation({ select: (location) => location.pathname });
  const unsupported = useUnsupportedSettingsCapabilities(
    pathname === "/settings/diagnostics" && scope?.environment
      ? { machine: scope.environment.environmentId }
      : scope?.search,
  );
  const gate = settingsPathGate(pathname, unsupported, useEnvironmentUiState() !== "unknown");
  if (gate === "wait") return null;
  return gate === "show" ? children : <Navigate to="/settings/general" replace />;
}
