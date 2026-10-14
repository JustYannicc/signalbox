import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { browserSession, NO_STORE_HEADERS, requestUrl } from "../http/credentials.ts";
import { PreviewSetup } from "./PreviewSetup.ts";
import {
  PREVIEW_SETUP_AUTHORIZE_PATH,
  PREVIEW_SETUP_CALLBACK_PATH,
  PREVIEW_SETUP_REDEEM_PATH,
  PREVIEW_SETUP_START_PATH,
  PreviewSetupRedeemRequest,
  REDEEM_ERROR_STATUS,
} from "./previewSetupWire.ts";

/** The hand-off's routes (`PreviewSetup.ts`). Each reads the request and calls one step. */

const browserUser = Effect.map(browserSession, (session) =>
  Option.isSome(session) ? session.value.userId : null,
);

const redirect = (location: string) =>
  HttpServerResponse.redirect(location, { headers: NO_STORE_HEADERS });

const startRoute = HttpRouter.add(
  "GET",
  PREVIEW_SETUP_START_PATH,
  Effect.gen(function* () {
    const url = yield* requestUrl;
    const location = yield* (yield* PreviewSetup).start({
      userId: yield* browserUser,
      origin: url.origin,
      returnTo: url.searchParams.get("returnTo"),
    });
    return redirect(location);
  }),
);

const authorizeRoute = HttpRouter.add(
  "GET",
  PREVIEW_SETUP_AUTHORIZE_PATH,
  Effect.gen(function* () {
    const url = yield* requestUrl;
    const location = yield* (yield* PreviewSetup).authorize({
      userId: yield* browserUser,
      origin: url.searchParams.get("origin") ?? "",
      challenge: url.searchParams.get("challenge") ?? "",
      state: url.searchParams.get("state") ?? "",
    });
    return location === null
      ? HttpServerResponse.text("That address can't take a Signalbox setup.", {
          status: 400,
          headers: NO_STORE_HEADERS,
        })
      : redirect(location);
  }).pipe(
    Effect.catch((cause) =>
      Effect.logError("preview setup authorize failed", { cause }).pipe(
        Effect.as(
          HttpServerResponse.text("Internal Server Error", {
            status: 500,
            headers: NO_STORE_HEADERS,
          }),
        ),
      ),
    ),
  ),
);

const callbackRoute = HttpRouter.add(
  "GET",
  PREVIEW_SETUP_CALLBACK_PATH,
  Effect.gen(function* () {
    const url = yield* requestUrl;
    const location = yield* (yield* PreviewSetup).callback({
      userId: yield* browserUser,
      origin: url.origin,
      state: url.searchParams.get("state") ?? "",
      code: url.searchParams.get("code"),
    });
    return redirect(location);
  }),
);

const redeemRoute = HttpRouter.add(
  "POST",
  PREVIEW_SETUP_REDEEM_PATH,
  Effect.gen(function* () {
    const body = yield* HttpServerRequest.schemaBodyJson(PreviewSetupRedeemRequest);
    const setup = yield* (yield* PreviewSetup).redeem(body);
    return HttpServerResponse.jsonUnsafe(setup, { headers: NO_STORE_HEADERS });
  }).pipe(
    Effect.catchTags({
      SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      HttpServerError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      PreviewSetupRedeemError: (error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: error.reason },
            { status: REDEEM_ERROR_STATUS[error.reason], headers: NO_STORE_HEADERS },
          ),
        ),
    }),
  ),
);

export const layer = Layer.mergeAll(startRoute, authorizeRoute, callbackRoute, redeemRoute);
