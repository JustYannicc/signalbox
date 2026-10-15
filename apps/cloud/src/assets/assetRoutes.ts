import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { NO_STORE_HEADERS, requestUrl } from "../http/credentials.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import * as CloudAssets from "./CloudAssets.ts";

/**
 * `GET /api/assets/<token>/<name>`: the image or attachment a `CloudAssets` URL names. The
 * token is the only credential, since an `<img>` on another origin (desktop,
 * mobile) sends no session; the read runs as the user it was issued to, with
 * their contexts as they are now. The name is only for whoever saves the file.
 */

const notFound = () =>
  HttpServerResponse.text("Not Found", {
    status: 404,
    headers: { ...NO_STORE_HEADERS, "x-content-type-options": "nosniff" },
  });

const unavailable = (cause: unknown) =>
  Effect.logError("cloud asset read failed", { cause }).pipe(
    Effect.as(
      HttpServerResponse.text("Service Unavailable", {
        status: 503,
        headers: NO_STORE_HEADERS,
      }),
    ),
  );

const serve = Effect.gen(function* () {
  // Read off the path: tokens outgrow the router's 100-character limit on a `:param`.
  const { pathname } = yield* requestUrl;
  const [token, name, ...rest] = pathname
    .slice(`${CloudAssets.ASSET_ROUTE_PREFIX}/`.length)
    .split("/");
  if (!token || !name || rest.length > 0) return notFound();
  const assets = yield* CloudAssets.CloudAssets;
  const granted = yield* assets.verify(token);
  if (granted === null) return notFound();
  const contextIds = yield* (yield* UserDirectory.UserDirectory)
    .forUser(granted.userId)
    .contextIds();
  const actor = { userId: granted.userId, contextIds };
  if (granted.resource._tag === "attachment") {
    const file = yield* assets.openAttachment(actor, granted.resource);
    return file === null
      ? notFound()
      : HttpServerResponse.raw(file.body, {
          headers: file.headers,
          contentType: file.headers["content-type"],
          contentLength: file.size,
        });
  }
  const image = yield* assets.read(actor, granted.resource);
  if (image === null) return notFound();
  return HttpServerResponse.uint8Array(image.bytes, {
    contentType: image.mimeType,
    // Same as a self-hosted server's: the bytes behind a token never change.
    headers: { "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
  });
}).pipe(Effect.catchTags({ UserObjectError: unavailable, ThreadObjectError: unavailable }));

export const layer = HttpRouter.add("GET", `${CloudAssets.ASSET_ROUTE_PREFIX}/*`, serve);
