const commandObservationKey = "__sb1070CommandObservation";
export function observeCommandInvocation<T extends object>(
  command: T,
  path: string,
  invocationId: string,
) {
  if (Object.hasOwn(command, commandObservationKey))
    throw new Error("Command observation key collision");
  const observed = {
    ...command,
    [commandObservationKey]: { route: { method: "POST", path }, invocationId },
  };
  readCommandObservation(observed);
  return observed;
}

/** Embedded in the observer shim so a cached worker reads this call's route. */
export function readCommandObservation(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Command observer input is missing");
  const { __sb1070CommandObservation: observation, ...command } = input as Record<string, unknown>;
  if (!observation || typeof observation !== "object" || Array.isArray(observation))
    throw new Error("Command observation is missing");
  const { route, invocationId } = observation as Record<string, unknown>;
  if (!route || typeof route !== "object" || Array.isArray(route))
    throw new Error("Command observation route is missing");
  const { method, path } = route as Record<string, unknown>;
  if (
    method !== "POST" ||
    typeof path !== "string" ||
    !/^(?:\/turn\/[123]\/dispatch|\/replace\/dispatch|\/observer-calibration|\/claude\/(?:baseline|hooks)\/(?:turn\/[123]|replace|finish)\/dispatch)$/.test(
      path,
    ) ||
    typeof invocationId !== "string" ||
    !invocationId
  )
    throw new Error("Command observation identity is invalid");
  return { command, call: { route: { method, path }, invocationId } };
}
