import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";

export type PreviewPermission = "granted" | "denied" | "unresolved";

export interface BrowserSettingsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly configKnown: boolean;
  readonly serverBrowser: boolean;
  readonly devices: boolean;
  readonly previewPermission: PreviewPermission;
}

export function resolveBrowserSettingsAvailability(input: {
  readonly isElectron: boolean;
  readonly environmentsReady: boolean;
  readonly environments: ReadonlyArray<BrowserSettingsEnvironment>;
}) {
  const serverBrowserEnvironmentIds = input.environments.flatMap((environment) =>
    environment.connectionPhase === "connected" &&
    environment.serverBrowser &&
    environment.previewPermission === "granted"
      ? [environment.environmentId]
      : [],
  );
  // Keep every known server profile as a cleanup target. A disconnected or
  // unauthorized target must fail the clear rather than disappear from it.
  const serverBrowserClearEnvironmentIds = input.environments.flatMap((environment) =>
    environment.serverBrowser ? [environment.environmentId] : [],
  );
  const devices = input.environments.some(
    (environment) => environment.connectionPhase === "connected" && environment.devices,
  );

  const waitingForServerBrowser =
    !input.environmentsReady ||
    input.environments.some(
      (environment) =>
        (environment.connectionPhase === "connected" && !environment.configKnown) ||
        ((environment.connectionPhase === "connecting" ||
          environment.connectionPhase === "reconnecting") &&
          (!environment.configKnown || environment.serverBrowser)) ||
        (environment.connectionPhase === "connected" &&
          environment.serverBrowser &&
          environment.previewPermission === "unresolved"),
    );
  const waitingForDevice =
    !input.environmentsReady ||
    input.environments.some(
      (environment) =>
        (environment.connectionPhase === "connected" && !environment.configKnown) ||
        ((environment.connectionPhase === "connecting" ||
          environment.connectionPhase === "reconnecting") &&
          (!environment.configKnown || environment.devices)),
    );

  const serverBrowser = serverBrowserEnvironmentIds.length > 0;
  const interactiveBrowser = input.isElectron || serverBrowser;
  const floatingPreview = interactiveBrowser || devices;

  return {
    browserProfiles: interactiveBrowser,
    viewport: interactiveBrowser,
    desktopViewDefaults: input.isElectron,
    recording: input.isElectron,
    appLinkTarget: interactiveBrowser,
    floatingPreview,
    checkingBrowserSettings: !interactiveBrowser && waitingForServerBrowser,
    checkingAppLinkTarget: !interactiveBrowser && waitingForServerBrowser,
    checkingFloatingPreview: !floatingPreview && (waitingForServerBrowser || waitingForDevice),
    serverBrowserEnvironmentIds,
    serverBrowserClearEnvironmentIds,
  };
}
