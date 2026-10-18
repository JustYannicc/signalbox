import { PERSON_TIMEZONE_WS_METHODS } from "@t3tools/contracts/personTimezone";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createPersonTimezoneAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const settings = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "person-timezone:settings",
    tag: PERSON_TIMEZONE_WS_METHODS.get,
  });

  return {
    settings,
    set: createEnvironmentRpcCommand(runtime, {
      label: "person-timezone:set",
      tag: PERSON_TIMEZONE_WS_METHODS.set,
      onSettled: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(settings({ environmentId, input: {} }))),
    }),
    report: createEnvironmentRpcCommand(runtime, {
      label: "person-timezone:report",
      tag: PERSON_TIMEZONE_WS_METHODS.report,
      onSettled: ({ environmentId }, registry) =>
        Effect.sync(() => registry.refresh(settings({ environmentId, input: {} }))),
    }),
  };
}
