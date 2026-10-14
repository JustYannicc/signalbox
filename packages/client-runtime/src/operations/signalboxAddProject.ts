/**
 * signalbox: whether Add project can start yet. Right after sign-in the
 * environments are still connecting (on Signalbox Cloud, every time), and
 * sending the user to connection settings then would be wrong: they have an
 * environment, it just isn't ready. Clients wait instead and continue once one
 * connects.
 */
import type { EnvironmentConnectionPhase } from "../connection/presentation.ts";

/** `unavailable`: nothing is connected or on its way, so the user has to connect something. */
export type AddProjectAvailability = "ready" | "connecting" | "unavailable";

export function resolveAddProjectAvailability(input: {
  readonly catalogReady: boolean;
  readonly phases: ReadonlyArray<EnvironmentConnectionPhase>;
}): AddProjectAvailability {
  if (input.phases.includes("connected")) return "ready";
  if (
    !input.catalogReady ||
    input.phases.includes("connecting") ||
    input.phases.includes("reconnecting")
  ) {
    return "connecting";
  }
  return "unavailable";
}
