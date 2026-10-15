// @effect-diagnostics nodeBuiltinImport:off - probed once while the environment is built, before any layer exists.
import * as NodeFS from "node:fs";

import type { DesktopSettings } from "../settings/DesktopAppSettings.ts";

/**
 * Signalbox's default desktop build is a thin client for Signalbox Cloud: it
 * ships without the local server and the harness CLIs and provider runtimes
 * that come with it (`scripts/build-desktop-artifact.ts`, unless
 * `--local-server`). The build is the switch, so a packaged app looks for the
 * server entry instead of trusting a flag. Development runs from source and
 * always has the server.
 */
export function probeLocalServer(backendEntryPath: string): boolean {
  return NodeFS.existsSync(backendEntryPath);
}

/** Without a bundled server the local environment stays off, whatever the settings file says. */
export function withLocalServerAvailability(
  settings: DesktopSettings,
  localServerBundled: boolean,
): DesktopSettings {
  return localServerBundled || !settings.localEnvironmentEnabled
    ? settings
    : { ...settings, localEnvironmentEnabled: false };
}
