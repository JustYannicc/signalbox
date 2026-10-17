import { environmentCanWriteModelSettings, environmentSupports } from "@t3tools/contracts";

/**
 * Signalbox Cloud accepts only model settings. Gate each patch against the
 * selected environment before sending it.
 */

interface SettingsTarget {
  readonly serverConfig: {
    readonly environment?: {
      readonly capabilities: {
        readonly serverSettingsWrite?: boolean;
        readonly modelSettingsWrite?: boolean;
      };
    };
  } | null;
}

/** Whether the environment saves server settings. One without a config yet may. */
export function acceptsServerSettings(environment: SettingsTarget) {
  return environmentSupports(
    environment.serverConfig?.environment?.capabilities,
    "serverSettingsWrite",
  );
}

function acceptsModelSettings(environment: SettingsTarget) {
  return environmentCanWriteModelSettings(environment.serverConfig?.environment?.capabilities);
}

const MODEL_SETTINGS_PATCH_KEYS = new Set([
  "setModelFavorites",
  "setModelsHidden",
  "setProviderModelOrder",
  "favorites",
  "providerModelPreferences",
  "migrateModelPreferences",
  "defaultModelSelection",
]);

export function acceptsServerSettingsPatch(
  environment: SettingsTarget,
  serverKeys: Iterable<string>,
) {
  const keys = [...serverKeys];
  return keys.length > 0 && keys.every((key) => MODEL_SETTINGS_PATCH_KEYS.has(key))
    ? acceptsModelSettings(environment)
    : acceptsServerSettings(environment);
}

/** Whether server-scoped rows have anywhere to save. Nothing connected yet counts as yes. */
export function serverSettingsWritable(environments: readonly SettingsTarget[]): boolean {
  return environments.length === 0 || environments.some(acceptsServerSettings);
}

export function modelSettingsWritable(environments: readonly SettingsTarget[]): boolean {
  return environments.length === 0 || environments.some(acceptsModelSettings);
}
