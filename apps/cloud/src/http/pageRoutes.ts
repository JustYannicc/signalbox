import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import * as CloudSessions from "../auth/CloudSessions.ts";
import { NO_STORE_HEADERS, requestCredentials } from "./credentials.ts";

/** A JSON answer to one of Signalbox's own pages, never cached. */
export const pageJson = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE_HEADERS });

/** A refusal the page shows as `message`; `error` is for code. */
export const pageFailure = (status: number, error: string, message: string) =>
  pageJson({ error, message }, status);

/** Anything unexpected is logged and answered with `fallback`, which says nothing about the request. */
export const guarded = <E, R>(
  name: string,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  fallback: HttpServerResponse.HttpServerResponse,
) =>
  handler.pipe(
    Effect.catch((cause) => Effect.logError(`${name} failed`, { cause }).pipe(Effect.as(fallback))),
  );

export type PageUser =
  | { readonly _tag: "user"; readonly userId: string }
  | { readonly _tag: "cross_site" }
  | { readonly _tag: "signed_out" };

/**
 * The signed-in user behind a request from Signalbox's own pages. A cookie is
 * sent with cross-site form posts too, so it only counts from this origin; a
 * bearer can't be set cross-site, so it always does.
 */
export const pageUser = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const credentials = requestCredentials(request);
  if (credentials.bearer === undefined && request.headers["sec-fetch-site"] !== "same-origin") {
    return { _tag: "cross_site" } satisfies PageUser;
  }
  const session = yield* (yield* CloudSessions.CloudSessions)
    .authenticate(credentials)
    .pipe(Effect.option);
  return Option.isNone(session)
    ? ({ _tag: "signed_out" } satisfies PageUser)
    : ({ _tag: "user", userId: session.value.userId } satisfies PageUser);
});

/**
 * Runs `handler` for the signed-in user of one of Signalbox's own pages, or
 * answers why there isn't one. `forbidden` is what a cross-site request is told.
 */
export const withPageUser =
  (forbidden: string) =>
  <E, R>(handler: (userId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.flatMap(pageUser, (user) => {
      switch (user._tag) {
        case "user":
          return handler(user.userId);
        case "cross_site":
          return Effect.succeed(pageFailure(403, "forbidden", forbidden));
        case "signed_out":
          return Effect.succeed(pageFailure(401, "unauthorized", "Sign in to Signalbox first."));
      }
    });
