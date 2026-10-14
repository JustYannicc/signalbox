/**
 * signalbox: parts of a self-hosted server an environment may not have.
 *
 * Signalbox Cloud runs threads on machines nobody operates, so it advertises
 * these as `false` and clients hide the controls instead of sending requests
 * it rejects. Absent means supported: T3 Code and self-hosted Signalbox
 * servers never send them and keep every control.
 */
import * as Schema from "effect/Schema";

export const SignalboxEnvironmentCapabilityFields = {
  /** Serves `terminal.*`: the terminal drawer and running scripts in it. */
  terminal: Schema.optionalKey(Schema.Boolean),
  /** Starts threads in new or existing git worktrees, not only the project checkout. */
  worktrees: Schema.optionalKey(Schema.Boolean),
  /** Serves `server.updateSettings`. Client-only settings stay either way. */
  serverSettingsWrite: Schema.optionalKey(Schema.Boolean),
  /** Serves `device.*`: the iOS Simulators and Android Emulators on its device hosts. */
  devices: Schema.optionalKey(Schema.Boolean),
  /** Serves scheduled tasks (`scheduledTasks.*`, `subscribeScheduledTasks`). */
  scheduledTasks: Schema.optionalKey(Schema.Boolean),
  /** Its filesystem is a machine the user reaches: it serves `filesystem.browse`, and its
      absolute paths mean something outside Signalbox. */
  localFilesystem: Schema.optionalKey(Schema.Boolean),
  /** Adds projects from any git clone URL, not only the source control hosts it discovers. */
  cloneFromUrl: Schema.optionalKey(Schema.Boolean),
  /** The user runs this server, so they set how it is reached: network exposure, endpoints,
      Tailscale and the Signalbox Connect relay. */
  remoteAccess: Schema.optionalKey(Schema.Boolean),
  /** Serves pairing links and the list of paired clients. */
  accessManagement: Schema.optionalKey(Schema.Boolean),
};

export type SignalboxEnvironmentCapability = keyof typeof SignalboxEnvironmentCapabilityFields;

/** Whether an environment can do `capability`. Unknown (no config yet) and absent are supported. */
export function environmentSupports(
  capabilities: { readonly [K in SignalboxEnvironmentCapability]?: boolean } | null | undefined,
  capability: SignalboxEnvironmentCapability,
): boolean {
  return capabilities?.[capability] !== false;
}
