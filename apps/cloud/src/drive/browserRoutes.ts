import { BROWSER_PATHS, browserJson } from "@signalbox/runner-protocol/BrowserProtocol";
import * as Effect from "effect/Effect";
import { ThreadId } from "@t3tools/contracts";
import { ThreadDirectory } from "../thread/ThreadDirectory.ts";

import { UserDirectory } from "../user/UserDirectory.ts";
import { decodeBody, json, text } from "./routeResponses.ts";

/**
 * The person's browser API (`BrowserProtocol.ts`) under the drive API's
 * prefix (#574). The drive route has already checked the thread's drive
 * token. The session opens in the thread's owner's object, as the owner:
 * the profile is always theirs, never one the machine names. A sign-in
 * (#576) runs there too, and only during a turn: it's that turn's agent asking.
 */

export const isBrowserApiPath = (pathname: string) =>
  pathname === BROWSER_PATHS.session ||
  pathname === BROWSER_PATHS.end ||
  pathname === BROWSER_PATHS.signIn ||
  pathname === BROWSER_PATHS.previewUrl;

/** One person's browser request from the thread's machine, for the thread `auth` names. */
export const serveBrowserRequest = (
  auth: {
    readonly userId: string;
    readonly threadId: string;
    /** Whether a turn runs: browsers open only during a live harness run. */
    readonly live: boolean;
  },
  pathname: string,
  body: string,
) =>
  Effect.gen(function* () {
    const users = yield* UserDirectory;
    const owner = users.forUser(auth.userId);
    if (pathname === BROWSER_PATHS.previewUrl) {
      const request = decodeBody(browserJson.previewUrlRequest.decode, body);
      if (request === null) return text("Unreadable request.", 400);
      if (!auth.live)
        return json(
          browserJson.previewUrl.encode({
            _tag: "refused",
            message: "Only a running turn opens a preview.",
          }),
        );
      const contextIds = yield* owner.contextIds();
      const threads = yield* ThreadDirectory;
      const answer = yield* threads
        .forThread(ThreadId.make(auth.threadId))
        .previewLink({ userId: auth.userId, contextIds }, request.port, true, {
          path: request.path,
          agent: true,
        });
      return json(
        browserJson.previewUrl.encode(
          answer._tag === "ok"
            ? { _tag: "ready", url: answer.url }
            : { _tag: "refused", message: answer.message },
        ),
      );
    }
    if (pathname === BROWSER_PATHS.end) {
      const request = decodeBody(browserJson.endRequest.decode, body);
      if (request === null) return text("Unreadable request.", 400);
      yield* owner.endBrowser({ threadId: auth.threadId, sessionId: request.sessionId });
      return text("Ended.", 200);
    }
    if (pathname === BROWSER_PATHS.signIn) {
      const request = decodeBody(browserJson.signInRequest.decode, body);
      if (request === null) return text("Unreadable request.", 400);
      if (!auth.live) {
        return json(
          browserJson.signIn.encode({
            _tag: "not_allowed",
            site: request.site,
            message: "Only a running turn signs agents in.",
          }),
        );
      }
      // A cloud turn's requester is the thread's owner today (#245).
      const answer = yield* owner.browserSignIn({
        threadId: auth.threadId,
        requester: auth.userId,
        site: request.site,
      });
      return json(browserJson.signIn.encode(answer));
    }
    if (!auth.live) {
      return json(
        browserJson.session.encode({
          _tag: "refused",
          message: "Only a running turn opens the person's browser.",
        }),
      );
    }
    // A cloud turn's requester is the thread's owner today (#245).
    const answer = yield* owner.browserSession({
      threadId: auth.threadId,
      requester: auth.userId,
    });
    return json(browserJson.session.encode(answer));
  }).pipe(
    // The thread, never a session's URLs.
    Effect.withSpan("BrowserRoutes.request", {
      attributes: { "thread.id": auth.threadId, "browser.path": pathname },
    }),
    // The owner's object didn't answer; the machine retries.
    Effect.catchTags({
      ThreadObjectError: (error) =>
        Effect.logWarning("a preview request failed", { cause: error.cause }).pipe(
          Effect.as(text("The preview is unavailable right now.", 503)),
        ),
      UserObjectError: (error) =>
        Effect.logWarning("a person's browser request failed", { cause: error.cause }).pipe(
          Effect.as(text("The thread's owner is unavailable right now.", 503)),
        ),
    }),
  );
