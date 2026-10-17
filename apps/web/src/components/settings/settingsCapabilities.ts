import type { SignalboxEnvironmentCapability } from "@t3tools/contracts";

const PAGE_CAPABILITIES: Readonly<Record<string, SignalboxEnvironmentCapability>> = {
  "/settings/storage": "localFilesystem",
  "/settings/diagnostics": "localFilesystem",
  "/settings/scheduled-tasks": "scheduledTasks",
  "/settings/connections": "otherEnvironments",
};

const ITEM_CAPABILITIES: Readonly<Record<string, readonly SignalboxEnvironmentCapability[]>> = {
  diagnostics: ["localFilesystem"],
  "environment-identification": ["otherEnvironments"],
  "usage-providers": ["serverSettingsWrite"],
  "cursor-keychain-usage": ["serverSettingsWrite"],
  "provider-health-check-interval": ["serverSettingsWrite"],
  "github-accounts": ["serverSettingsWrite"],
  "product-analytics": ["serverSettingsWrite"],
  "project-actions": ["terminal", "serverSettingsWrite"],
};

export function settingsPathSupported(
  path: string,
  unsupported: ReadonlySet<SignalboxEnvironmentCapability>,
): boolean {
  const capability = PAGE_CAPABILITIES[path];
  return capability === undefined || !unsupported.has(capability);
}

/** Search, the palette and section gates use the same requirements. */
export function settingsItemSupported(
  id: string,
  unsupported: ReadonlySet<SignalboxEnvironmentCapability>,
): boolean {
  const requirements = id.startsWith("source-control-host-")
    ? ["serverSettingsWrite" as const]
    : (ITEM_CAPABILITIES[id] ?? []);
  return requirements.every((capability) => !unsupported.has(capability));
}
