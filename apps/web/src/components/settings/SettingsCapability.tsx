import { Navigate, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { settingsItemSupported, settingsPathSupported } from "./settingsCapabilities";
import { useUnsupportedSettingsCapabilities } from "./useAvailableSettingsSearchItems";

/** Skip mounting controls whose requests the selected server cannot serve. */
export function SettingsCapability({ id, children }: { id: string; children: ReactNode }) {
  const scope = useOptionalSettingsScope();
  const unsupported = useUnsupportedSettingsCapabilities(
    id === "diagnostics" && scope?.environment
      ? { machine: scope.environment.environmentId }
      : scope?.search,
  );
  return settingsItemSupported(id, unsupported) ? children : null;
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
  return settingsPathSupported(pathname, unsupported) ? (
    children
  ) : (
    <Navigate to="/settings/general" replace />
  );
}
