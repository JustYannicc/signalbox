import { SIGNALBOX_APP_URL } from "@t3tools/shared/signalboxAppUrl";

import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { isDesktop } from "./accountPlatform";

/**
 * Signalbox Cloud is the desktop app's default environment. Without a local
 * environment, signing in on desktop signs in to the cloud and adds it, so a
 * fresh install with nothing connected lands on `/sign-in` instead of an
 * empty "connect a computer" page. Null everywhere else: web signs in to its
 * own origin, and a desktop running its local server signs in to that.
 */
export function cloudDefaultOrigin(): string | null {
  return isDesktop() && isLocalEnvironmentDisabled() ? SIGNALBOX_APP_URL : null;
}

/** False on the thin cloud desktop build, which has no local server to turn on. */
export function isLocalEnvironmentAvailable(): boolean {
  return window.desktopBridge?.getLocalEnvironmentAvailable?.() !== false;
}
