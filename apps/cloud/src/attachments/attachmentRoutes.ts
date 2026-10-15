import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ATTACHMENT_UPLOAD_PATH, CloudAttachments } from "./CloudAttachments.ts";

/**
 * `POST /api/attachments/upload/<token>`: the bytes `attachments.createUploadUrl`
 * promised, exactly as many. The signed token is the only credential, so a
 * desktop or mobile client uploads without a cookie. Sent attachments load
 * through `CloudAssets` (`assets/assetRoutes.ts`).
 */

/**
 * The signed token at the end of `url`. Tokens outgrow the router's path
 * parameters (100 characters), so the route matches a wildcard and reads it here,
 * as the self-hosted server's upload route does.
 */
const tokenAfter = (url: string) => {
  const { pathname } = new URL(url, "http://cloud");
  const prefix = `${ATTACHMENT_UPLOAD_PATH}/`;
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
};

const upload = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const web = yield* HttpServerRequest.toWeb(request);
  const token = tokenAfter(web.url);
  const declared = web.headers.get("content-length");
  const declaredSize = declared === null ? null : Number(declared);
  if (declaredSize !== null && !Number.isSafeInteger(declaredSize)) {
    return HttpServerResponse.text("Bad Request", { status: 400 });
  }
  const outcome = yield* (yield* CloudAttachments).storeUpload(token, web.body, declaredSize);
  switch (outcome._tag) {
    case "stored":
      return HttpServerResponse.empty({ status: 204 });
    case "unknown":
      return HttpServerResponse.text("Not Found", { status: 404 });
    case "wrong-size":
      return HttpServerResponse.text(`The body must be exactly ${outcome.sizeBytes} bytes.`, {
        status: 400,
      });
  }
}).pipe(
  Effect.catchTags({
    RequestParseError: () =>
      Effect.succeed(HttpServerResponse.text("Bad Request", { status: 400 })),
  }),
);

export const layer = HttpRouter.add("POST", `${ATTACHMENT_UPLOAD_PATH}/*`, upload);
