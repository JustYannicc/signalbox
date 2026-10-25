import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { RpcClientError } from "effect/rpc";

import { ConnectionTransientError } from "../connection/model.ts";

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isConnectionTransientError = Schema.is(ConnectionTransientError);

/** A transport failure cannot tell us whether the server committed the command. */
export function isOptimisticCommandOutcomeUnknown(cause: Cause.Cause<unknown>): boolean {
  if (Cause.hasInterrupts(cause) || Cause.hasDies(cause)) return true;
  return cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      (isRpcClientError(reason.error) ||
        isConnectionTransientError(reason.error) ||
        Cause.isTimeoutError(reason.error)),
  );
}
