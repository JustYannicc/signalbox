import { environmentSupports } from "@t3tools/contracts";

/**
 * Signalbox: environments that never save server settings (Signalbox Cloud
 * serves no `server.updateSettings`). Their server-scoped rows hide, and
 * writes skip them when they are selected alongside ones that do.
 */

interface SettingsTarget {
  readonly serverConfig: {
    readonly environment?: { readonly capabilities: { readonly serverSettingsWrite?: boolean } };
  } | null;
}

/** Whether the environment saves server settings. One without a config yet may. */
export function acceptsServerSettings(environment: SettingsTarget) {
  return environmentSupports(
    environment.serverConfig?.environment?.capabilities,
    "serverSettingsWrite",
  );
}

/** Whether server-scoped rows have anywhere to save. Nothing connected yet counts as yes. */
export function serverSettingsWritable(environments: readonly SettingsTarget[]): boolean {
  return environments.length === 0 || environments.some(acceptsServerSettings);
}
