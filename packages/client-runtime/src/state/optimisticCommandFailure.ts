import * as Cause from "effect/Cause";

/** A transport failure cannot tell us whether the server committed the command. */
export function isOptimisticCommandOutcomeUnknown(cause: Cause.Cause<unknown>): boolean {
  if (Cause.hasInterrupts(cause) || Cause.hasDies(cause)) return true;
  return cause.reasons.some((reason) => {
    if (!Cause.isFailReason(reason)) return false;
    const error = reason.error;
    if (typeof error !== "object" || error === null || !("_tag" in error)) return false;
    return (
      error._tag === "RpcClientError" ||
      error._tag === "ConnectionTransientError" ||
      error._tag === "EnvironmentRpcUnavailableError" ||
      error._tag === "EnvironmentNotRegisteredError" ||
      error._tag === "TimeoutError"
    );
  });
}
