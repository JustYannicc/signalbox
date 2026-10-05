export interface SignalboxProcessEnvironment {
  SIGNALBOX_HOME?: string;
  SIGNALBOX_PORT?: string;
  T3CODE_HOME?: string;
  T3CODE_PORT?: string;
  T3_BOOT_SERVICE_UNIT?: string;
}

/** Translate Signalbox's public environment names at a process boundary. */
export function applySignalboxEnvironment(environment: SignalboxProcessEnvironment): void {
  // bootService.ts writes these two marker values for systemd and launchd.
  const isSignalboxServiceUnit =
    environment.T3_BOOT_SERVICE_UNIT === "signalbox.service" ||
    environment.T3_BOOT_SERVICE_UNIT === "com.justyannicc.signalbox.service.plist";

  if (environment.SIGNALBOX_HOME !== undefined) {
    environment.T3CODE_HOME = environment.SIGNALBOX_HOME;
  } else if (!isSignalboxServiceUnit) {
    delete environment.T3CODE_HOME;
  }
  // Keep the public value so Signalbox child processes can apply the same mapping.

  if (environment.SIGNALBOX_PORT !== undefined) {
    environment.T3CODE_PORT = environment.SIGNALBOX_PORT;
  } else {
    delete environment.T3CODE_PORT;
  }
  // Desktop child backends receive their port through bootstrap instead.
  delete environment.SIGNALBOX_PORT;
}
