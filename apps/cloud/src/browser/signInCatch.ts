import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Socket from "effect/socket/Socket";

/**
 * Catches the end of a provider sign-in inside a browser driven over CDP
 * (#205). Claude's and ChatGPT's logins end by sending the browser to the
 * `redirect_uri` they were started with, a `localhost` address where the
 * pool's CLIProxyAPI would listen if it ran beside the browser. It doesn't,
 * so every page the browser opens has its requests to that address paused
 * (`Fetch.enable`): the paused request's URL is the address to hand back, and
 * the page gets a short "signed in" answer instead of a connection error.
 *
 * Only CDP's own messages pass here; a paused URL carries the login's code,
 * so it is handed on, never logged.
 */

export class SignInBrowserError extends Schema.TaggedError<SignInBrowserError>()(
  "SignInBrowserError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * The address a login redirects to when it ends, from its sign-in URL's
 * `redirect_uri`. Null when there is none, or it isn't a loopback address
 * the person's browser couldn't reach anyway.
 */
export const redirectTarget = (loginUrl: string): string | null => {
  const raw = URL.parse(loginUrl)?.searchParams.get("redirect_uri");
  const redirect = raw ? URL.parse(raw) : null;
  return redirect?.protocol === "http:" && isLocalLoopbackHost(redirect.hostname)
    ? `${redirect.origin}${redirect.pathname}`
    : null;
};

/** How long the browser gets to show its first page before the sign-in gives up. */
const PAGE_TIMEOUT = "20 seconds";

const decoder = new TextDecoder();

/** Whether `url` is the redirect itself, not just another address on its port. */
const isRedirect = (url: string, redirect: string) => {
  const parsed = URL.parse(url);
  return parsed !== null && `${parsed.origin}${parsed.pathname}` === redirect;
};

/** What the browser shows once the redirect is caught; the dialog closes moments later. */
const CAUGHT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signed in</title></head><body style="margin:0;height:100vh;display:grid;place-items:center;font:16px system-ui,sans-serif;color:#444">Signed in. Adding the account…</body></html>`;

const Message = Schema.Struct({
  id: Schema.optional(Schema.Number),
  sessionId: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
});
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(Message));

const Attached = Schema.Struct({
  sessionId: Schema.String,
  targetInfo: Schema.Struct({ type: Schema.String }),
  waitingForDebugger: Schema.optional(Schema.Boolean),
});
const decodeAttached = Schema.decodeUnknownOption(Attached);

const Paused = Schema.Struct({
  requestId: Schema.String,
  request: Schema.Struct({ url: Schema.String }),
});
const decodePaused = Schema.decodeUnknownOption(Paused);

/**
 * Drives the browser behind `socket` (its browser-level CDP endpoint) for one
 * sign-in: opens `loginUrl` in its page and waits for the redirect to
 * `redirect`. `redirected` is that redirect's full address; it fails when the
 * browser closes first. Runs until `Scope` closes.
 */
export const catchSignIn = (
  socket: Socket.Socket,
  input: { readonly loginUrl: string; readonly redirect: string },
): Effect.Effect<
  { readonly redirected: Effect.Effect<string, SignInBrowserError> },
  SignInBrowserError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const reader = yield* socket.reader.pipe(
      Effect.mapError(
        (cause) =>
          new SignInBrowserError({ message: "Could not reach the sign-in browser.", cause }),
      ),
    );
    const writer = yield* socket.writer;
    const caught = yield* Deferred.make<string, SignInBrowserError>();
    const pageReady = yield* Deferred.make<string>();
    let nextId = 0;

    /** Sends a command; answers are not awaited, a failed one shows up as the sign-in not ending. */
    const send = (method: string, params: object = {}, sessionId?: string) =>
      writer
        .write(
          JSON.stringify({ id: ++nextId, method, params, ...(sessionId ? { sessionId } : {}) }),
        )
        .pipe(Effect.ignore);

    const pattern = { urlPattern: `${input.redirect}*`, requestStage: "Request" };

    const onAttached = (params: unknown) =>
      Effect.gen(function* () {
        const attached = decodeAttached(params);
        if (Option.isNone(attached)) return;
        const { sessionId, targetInfo, waitingForDebugger } = attached.value;
        const page = targetInfo.type === "page";
        // Armed before the page runs, so even a popup that redirects at once is caught.
        if (page) yield* send("Fetch.enable", { patterns: [pattern] }, sessionId);
        if (waitingForDebugger) yield* send("Runtime.runIfWaitingForDebugger", {}, sessionId);
        if (page) yield* Deferred.succeed(pageReady, sessionId);
      });

    const onPaused = (params: unknown, sessionId: string | undefined) =>
      Effect.gen(function* () {
        const paused = decodePaused(params);
        if (Option.isNone(paused) || !sessionId) return;
        const { requestId, request } = paused.value;
        if (!isRedirect(request.url, input.redirect)) {
          return yield* send("Fetch.continueRequest", { requestId }, sessionId);
        }
        yield* send(
          "Fetch.fulfillRequest",
          {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: "content-type", value: "text/html; charset=utf-8" }],
            body: Base64.encode(CAUGHT_PAGE),
          },
          sessionId,
        );
        yield* Deferred.succeed(caught, request.url);
      });

    const onFrame = (frame: string | Uint8Array) => {
      const message = decodeMessage(typeof frame === "string" ? frame : decoder.decode(frame));
      if (Option.isNone(message)) return Effect.void;
      const { method, params, sessionId } = message.value;
      if (method === "Target.attachedToTarget") return onAttached(params);
      if (method === "Fetch.requestPaused") return onPaused(params, sessionId);
      return Effect.void;
    };

    yield* Effect.forever(
      Effect.flatMap(reader.pull, (frames) => Effect.forEach(frames, onFrame, { discard: true })),
    ).pipe(
      Effect.catchCause((cause) =>
        Deferred.fail(
          caught,
          new SignInBrowserError({ message: "The sign-in browser closed.", cause }),
        ),
      ),
      Effect.forkScoped,
    );

    // Every page, the one already open and any popup the login opens, gets the catch.
    yield* send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    // A browser that closes before it shows a page fails this at once.
    const closed = Deferred.await(caught).pipe(Effect.andThen(Effect.never));
    const page = yield* Deferred.await(pageReady).pipe(
      Effect.raceFirst(closed),
      Effect.timeoutOrElse({
        duration: PAGE_TIMEOUT,
        orElse: () =>
          Effect.fail(new SignInBrowserError({ message: "The sign-in browser opened no page." })),
      }),
    );
    yield* send("Page.navigate", { url: input.loginUrl }, page);
    return { redirected: Deferred.await(caught) };
  });
