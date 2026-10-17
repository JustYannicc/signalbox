import type { SignalboxEnvironmentCapability } from "@t3tools/contracts";

const PAGE_CAPABILITIES: Readonly<Record<string, SignalboxEnvironmentCapability>> = {
  "/settings/storage": "localFilesystem",
  "/settings/diagnostics": "localFilesystem",
  "/settings/scheduled-tasks": "scheduledTasks",
  "/settings/connections": "otherEnvironments",
};

const ITEM_CAPABILITIES: Readonly<Record<string, readonly SignalboxEnvironmentCapability[]>> = {
  // Stand-in until the cloud serves diagnostics.* (it reports no host to inspect).
  diagnostics: ["localFilesystem"],
  "environment-identification": ["otherEnvironments"],
  "usage-providers": ["serverSettingsWrite"],
  "cursor-keychain-usage": ["serverSettingsWrite"],
  "provider-health-check-interval": ["serverSettingsWrite"],
  "github-accounts": ["serverSettingsWrite"],
  // Stand-in until the cloud serves analytics.*; give it its own capability then.
  "product-analytics": ["serverSettingsWrite"],
  "project-actions": ["terminal", "serverSettingsWrite"],
};

function itemRequirements(id: string): readonly SignalboxEnvironmentCapability[] {
  return id.startsWith("source-control-host-")
    ? ["serverSettingsWrite"]
    : (ITEM_CAPABILITIES[id] ?? []);
}

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
  return itemRequirements(id).every((capability) => !unsupported.has(capability));
}

type SettingsGate = "show" | "hide" | "wait";

/**
 * Until an environment reports, absent capabilities mean "not known yet", not "supported":
 * mounting would flash cloud-incompatible controls and redirecting would bounce self-hosted links.
 */
function resolveGate(
  requirements: readonly SignalboxEnvironmentCapability[],
  unsupported: ReadonlySet<SignalboxEnvironmentCapability>,
  configKnown: boolean,
): SettingsGate {
  if (requirements.length === 0) return "show";
  if (!configKnown) return "wait";
  return requirements.some((capability) => unsupported.has(capability)) ? "hide" : "show";
}

export function settingsPathGate(
  path: string,
  unsupported: ReadonlySet<SignalboxEnvironmentCapability>,
  configKnown: boolean,
): SettingsGate {
  const capability = PAGE_CAPABILITIES[path];
  return resolveGate(capability ? [capability] : [], unsupported, configKnown);
}

export function settingsItemGate(
  id: string,
  unsupported: ReadonlySet<SignalboxEnvironmentCapability>,
  configKnown: boolean,
): SettingsGate {
  return resolveGate(itemRequirements(id), unsupported, configKnown);
}
