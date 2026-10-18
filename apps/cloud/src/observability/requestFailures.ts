import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerError, HttpServerResponse } from "effect/http";
import { HttpApiSchemaError } from "effect/http-api/HttpApiError";

const isUnexpected = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some((reason) => {
    if (reason._tag === "Interrupt") return false;
    const error = reason._tag === "Die" ? reason.defect : reason.error;
    if (HttpServerError.isHttpServerError(error)) {
      return error.reason._tag !== "RouteNotFound" && error.reason._tag !== "RequestParseError";
    }
    // HttpApiBuilder dies on bad request schemas as well as response encoding bugs.
    if (HttpApiSchemaError.is(error)) {
      return !["Params", "Headers", "Query", "Payload"].includes(error.kind);
    }
    return (
      !HttpServerResponse.isHttpServerResponse(error) || error.status < 400 || error.status >= 500
    );
  });

// HTTP still records status and duration; expected client failures are not incidents.
export const logRequestFailure = (cause: Cause.Cause<unknown>) =>
  isUnexpected(cause) ? Effect.logError("cloud request failed") : Effect.void;
