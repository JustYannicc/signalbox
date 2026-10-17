import * as Effect from "effect/Effect";
import * as ByteSize from "effect/ByteSize";
import * as Layer from "effect/Layer";
import {
  HttpIncomingMessage,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { NO_STORE_HEADERS, requestUrl } from "../http/credentials.ts";
import { UserDirectory } from "../user/UserDirectory.ts";
import { MAX_HOOK_BYTES } from "./webhookRequest.ts";

/** Signatures and bearer callback links authorize these requests, independent of browser sessions. */
const serve = Effect.gen(function* () {
  const { userId, hookId, token } = yield* HttpRouter.params;
  if (!userId || !hookId)
    return HttpServerResponse.empty({ status: 404, headers: NO_STORE_HEADERS });
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = yield* requestUrl;
  const body = new Uint8Array(yield* request.arrayBuffer);
  if (body.byteLength > MAX_HOOK_BYTES)
    return HttpServerResponse.empty({ status: 413, headers: NO_STORE_HEADERS });
  const result = yield* (yield* UserDirectory).forUser(userId).receiveHook({
    hookId,
    token: token ?? "",
    method: request.method,
    headers: { ...request.headers },
    query: url.search.slice(1),
    body,
  });
  return HttpServerResponse.jsonUnsafe(result, {
    status: result.status,
    headers: NO_STORE_HEADERS,
  });
}).pipe(
  Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_HOOK_BYTES)),
  Effect.catchTags({
    HttpServerError: () =>
      Effect.succeed(HttpServerResponse.empty({ status: 413, headers: NO_STORE_HEADERS })),
    UserObjectError: (error) =>
      Effect.logError("Cloud webhook acceptance failed", error.cause).pipe(
        Effect.as(HttpServerResponse.empty({ status: 503, headers: NO_STORE_HEADERS })),
      ),
  }),
);

export const layer = Layer.mergeAll(
  HttpRouter.add("*", "/api/hooks/:userId/:hookId/:token", serve),
  HttpRouter.add("POST", "/api/github/hooks/:userId/:hookId", serve),
);
