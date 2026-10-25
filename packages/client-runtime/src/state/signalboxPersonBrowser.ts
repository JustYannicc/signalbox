import { SIGNALBOX_PERSON_BROWSER_WS_METHODS } from "@t3tools/contracts/signalboxPersonBrowser";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** The one managed profile that belongs to a person's Signalbox Cloud account. */
export function createSignalboxPersonBrowserAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    profileStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:person-browser:profile-status",
      tag: SIGNALBOX_PERSON_BROWSER_WS_METHODS.profileStatus,
      staleTimeMs: 30_000,
    }),
    clearProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:person-browser:clear-profile",
      tag: SIGNALBOX_PERSON_BROWSER_WS_METHODS.clearProfile,
    }),
  };
}
