// @effect-diagnostics nodeBuiltinImport:off - probed once while the environment is built, before any layer exists.
import * as NodeFS from "node:fs";

import type { DesktopSettings } from "../settings/DesktopAppSettings.ts";

/**
 * Signalbox's desktop app is a gateway to the one cloud environment. Work runs
 * on the server; the app keeps only what a gateway needs: sign-in, notifications
 * and deep links. The device gateway for computer use and history (#360) belongs
 * here too: it dials out to the signed-in cloud environment, so nothing on the
 * laptop listens or runs agents.
 *
 * The shipped build leaves out upstream's local server, its harness CLIs and
 * provider runtimes (`scripts/build-desktop-artifact.ts`; `--local-server` only
 * keeps upstream's full app buildable). The build is the switch, so a packaged
 * app looks for the server entry instead of trusting a flag. Development runs
 * from source and keeps upstream's local server.
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
