import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  ATTACHMENT_FILE_PATH,
  ATTACHMENT_UPLOAD_PATH,
  CloudAttachments,
} from "./CloudAttachments.ts";

/**
 * The URLs `attachments.createUploadUrl` and `assets.createUrl` hand out. Each
 * carries its own signed token, so neither asks for a session: a desktop or
 * mobile client uploads and an `<img>` loads without a cookie.
 *
 * - `POST /api/attachments/upload/<token>`: the upload's bytes, exactly as many as promised.
 * - `GET /api/attachments/file/<token>`: a sent attachment's bytes.
 */

/**
 * The signed token at the end of `url`. Tokens outgrow the router's path
 * parameters (100 characters), so the routes match a wildcard and read it here,
 * as the self-hosted server's upload route does.
 */
const tokenAfter = (prefix: string, url: string) => {
  const pathname = new URL(url, "http://cloud").pathname;
  return pathname.startsWith(`${prefix}/`) ? pathname.slice(prefix.length + 1) : "";
};

const upload = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const web = yield* HttpServerRequest.toWeb(request);
  const token = tokenAfter(ATTACHMENT_UPLOAD_PATH, web.url);
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

const file = Effect.gen(function* () {
  const { url } = yield* HttpServerRequest.HttpServerRequest;
  const opened = yield* (yield* CloudAttachments).openFile(tokenAfter(ATTACHMENT_FILE_PATH, url));
  return opened === null
    ? HttpServerResponse.text("Not Found", { status: 404 })
    : HttpServerResponse.raw(opened.body, {
        headers: opened.headers,
        contentType: opened.headers["content-type"],
        contentLength: opened.size,
      });
});

export const layer = Layer.mergeAll(
  HttpRouter.add("POST", `${ATTACHMENT_UPLOAD_PATH}/*`, upload),
  HttpRouter.add("GET", `${ATTACHMENT_FILE_PATH}/*`, file),
);
