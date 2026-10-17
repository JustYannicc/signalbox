import { Navigate, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useEnvironmentCapabilitiesKnown } from "~/state/environmentCapabilities";
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
  const configKnown = useEnvironmentCapabilitiesKnown();
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
  const configKnown = useEnvironmentCapabilitiesKnown();
  // Connections' route guards itself on the environment UI state, which a signed-out desktop
  // gateway knows without any config; waiting here would leave it blank forever.
  if (pathname === "/settings/connections") return children;
  const gate = settingsPathGate(pathname, unsupported, configKnown);
  if (gate === "wait") return null;
  return gate === "show" ? children : <Navigate to="/settings/general" replace />;
}
