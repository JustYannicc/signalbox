import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { SignalboxPreviewOpenInput } from "@t3tools/contracts/signalboxPreviews";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as CloudSessions from "../auth/CloudSessions.ts";
import * as CloudThreadService from "../thread/CloudThreadService.ts";
import * as UserDirectory from "../user/UserDirectory.ts";
import { SESSION_COOKIE_NAME } from "../environment.ts";
import { NO_STORE_HEADERS, requestUrl } from "./credentials.ts";

/** A durable entry point which authenticates the browser before minting a preview ticket. */
export const PREVIEW_OPEN_PATH = "/api/cloud/threads/:threadId/previews/:port";

const decodePreviewInput = Schema.decodeUnknownOption(SignalboxPreviewOpenInput);

const text = (body: string, status: number) =>
  HttpServerResponse.text(body, { status, headers: NO_STORE_HEADERS });

const redirect = (location: string) =>
  HttpServerResponse.redirect(location, { headers: NO_STORE_HEADERS });

const previewOpen = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = yield* HttpRouter.params;
  const portText = params.port;
  const input =
    portText !== undefined && /^[1-9][0-9]*$/u.test(portText)
      ? decodePreviewInput({ threadId: params.threadId, port: Number(portText) })
      : undefined;
  if (input === undefined || input._tag === "None") {
    return text("This preview is unavailable.", 404);
  }
  const { threadId, port } = input.value;

  const returnTo = `/api/cloud/threads/${encodeURIComponent(threadId)}/previews/${port}`;
  const url = yield* requestUrl;
  const signIn = new URL("/sign-in", url.origin);
  signIn.searchParams.set("returnTo", returnTo);

  const sessions = yield* CloudSessions.CloudSessions;
  const session = yield* sessions
    .authenticate({ cookie: request.cookies[SESSION_COOKIE_NAME] })
    .pipe(Effect.catchTags({ CloudCredentialError: () => Effect.succeed(null) }));
  if (session === null) return redirect(signIn.toString());
  if (!session.scopes.includes(AuthOrchestrationOperateScope)) {
    return text("You can't open this preview.", 403);
  }

  const user = yield* UserDirectory.UserDirectory;
  const contextIds = yield* user.forUser(session.userId).contextIds();
  const link = yield* (yield* CloudThreadService.CloudThreadService).openPreview(
    { userId: session.userId, contextIds },
    threadId,
    port,
    true,
  );
  return link._tag === "ok" ? redirect(link.url) : text("This preview is unavailable.", 404);
}).pipe(
  Effect.catchTags({
    ThreadObjectError: (error) =>
      Effect.logError("opening a preview failed", { cause: error.cause }).pipe(
        Effect.as(text("Couldn't open this preview.", 500)),
      ),
    UserObjectError: (error) =>
      Effect.logError("opening a preview failed", { cause: error.cause }).pipe(
        Effect.as(text("Couldn't open this preview.", 500)),
      ),
  }),
);

export const layer = HttpRouter.add("GET", PREVIEW_OPEN_PATH, previewOpen);
