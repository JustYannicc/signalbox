import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerError, HttpServerResponse } from "effect/http";

const isUnexpected = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => {
    if (reason._tag === "Interrupt") return false;
    if (reason._tag === "Die") return true;
    const error = reason.error;
    if (HttpServerError.isHttpServerError(error)) {
      return error.reason._tag !== "RouteNotFound" && error.reason._tag !== "RequestParseError";
    }
    return (
      !HttpServerResponse.isHttpServerResponse(error) || error.status < 400 || error.status >= 500
    );
  });

// HTTP still records status and duration; expected client failures are not incidents.
export const logRequestFailure = (cause: Cause.Cause<unknown>) =>
  isUnexpected(cause) ? Effect.logError("cloud request failed") : Effect.void;
