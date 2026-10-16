import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Socket from "effect/socket/Socket";

import { catchSignIn, redirectTarget } from "./signInCatch.ts";

const LOGIN =
  "https://claude.ai/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=s1";
const REDIRECT = "http://localhost:54545/callback";

interface Sent {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

/**
 * A browser's CDP endpoint as a socket: records every command and lets the
 * test push events, as Chrome sends them over one flattened connection.
 */
const fakeBrowser = Effect.gen(function* () {
  const incoming = yield* Queue.unbounded<string, Socket.SocketError>();
  const sent: Array<Sent> = [];
  const unread = yield* Queue.unbounded<Sent>();
  const socket = Socket.make({
    reader: Effect.succeed({
      pull: Effect.map(Queue.take(incoming), (frame) => [frame] as const),
      upgrade: () => Effect.void,
    }),
    writer: Effect.succeed({
      write: (chunk) =>
        Effect.sync(() => {
          if (typeof chunk !== "string") return;
          const command = JSON.parse(chunk) as Sent;
          sent.push(command);
          Queue.offerUnsafe(unread, command);
        }),
      writeAll: () => Effect.void,
    }),
  });
  const emit = (message: object) => Queue.offer(incoming, JSON.stringify(message));
  const attach = (sessionId: string, type: string, waitingForDebugger: boolean) =>
    emit({
      method: "Target.attachedToTarget",
      params: { sessionId, targetInfo: { type }, waitingForDebugger },
    });
  const pause = (sessionId: string, requestId: string, url: string) =>
    emit({ method: "Fetch.requestPaused", sessionId, params: { requestId, request: { url } } });
  const close = Queue.fail(
    incoming,
    new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1006 }) }),
  );
  /** The next command sent with `method`, waiting for it; earlier ones are skipped. */
  const next = (method: string): Effect.Effect<Sent> =>
    Effect.flatMap(Queue.take(unread), (command) =>
      command.method === method ? Effect.succeed(command) : next(method),
    );
  return { socket, sent, attach, pause, close, next };
});

const commands = (sent: ReadonlyArray<Sent>, method: string) =>
  sent.filter((command) => command.method === method);

describe("redirectTarget", () => {
  it("reads the loopback redirect a login ends on", () => {
    expect(redirectTarget(LOGIN)).toBe(REDIRECT);
    expect(
      redirectTarget(
        "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
      ),
    ).toBe("http://localhost:1455/auth/callback");
  });

  it("has nothing to catch without a loopback redirect", () => {
    expect(redirectTarget("https://claude.ai/oauth/authorize?state=s")).toBeNull();
    expect(
      redirectTarget("https://x.test/?redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Fcode"),
    ).toBeNull();
    expect(redirectTarget("not a url")).toBeNull();
  });
});

describe("catchSignIn", () => {
  it.live("opens the login in the page and hands back the redirect it ends on", () =>
    Effect.gen(function* () {
      const browser = yield* fakeBrowser;
      const opening = yield* Effect.forkScoped(
        catchSignIn(browser.socket, { loginUrl: LOGIN, redirect: REDIRECT }),
      );
      yield* browser.next("Target.setAutoAttach");
      // Chrome attaches the page Kernel opened, paused until it is released.
      yield* browser.attach("page-1", "page", true);
      const { redirected } = yield* Fiber.join(opening);

      expect(commands(browser.sent, "Target.setAutoAttach")[0]?.params).toMatchObject({
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      const [enable] = commands(browser.sent, "Fetch.enable");
      expect(enable).toMatchObject({
        sessionId: "page-1",
        params: { patterns: [{ urlPattern: `${REDIRECT}*`, requestStage: "Request" }] },
      });
      // Armed before the page runs, then released, then sent to the login.
      const order = browser.sent.map((command) => command.method);
      expect(order.indexOf("Fetch.enable")).toBeLessThan(
        order.indexOf("Runtime.runIfWaitingForDebugger"),
      );
      expect(commands(browser.sent, "Page.navigate")[0]).toMatchObject({
        sessionId: "page-1",
        params: { url: LOGIN },
      });

      // A popup the login opens (Google, say) gets the same catch.
      yield* browser.attach("popup-1", "page", true);
      // A service worker is only released.
      yield* browser.attach("worker-1", "service_worker", true);
      const callback = `${REDIRECT}?code=abc&state=s1`;
      yield* browser.pause("popup-1", "req-7", callback);
      expect(yield* redirected).toBe(callback);

      expect(commands(browser.sent, "Fetch.enable").map((c) => c.sessionId)).toEqual([
        "page-1",
        "popup-1",
      ]);
      expect(
        commands(browser.sent, "Runtime.runIfWaitingForDebugger").map((c) => c.sessionId),
      ).toEqual(["page-1", "popup-1", "worker-1"]);
      // The page shows a short answer instead of a connection error.
      expect(commands(browser.sent, "Fetch.fulfillRequest")[0]).toMatchObject({
        sessionId: "popup-1",
        params: { requestId: "req-7", responseCode: 200 },
      });
    }).pipe(Effect.scoped),
  );

  it.live("lets every other paused request through", () =>
    Effect.gen(function* () {
      const browser = yield* fakeBrowser;
      const opening = yield* Effect.forkScoped(
        catchSignIn(browser.socket, { loginUrl: LOGIN, redirect: REDIRECT }),
      );
      yield* browser.next("Target.setAutoAttach");
      yield* browser.attach("page-1", "page", false);
      yield* Fiber.join(opening);
      yield* browser.pause("page-1", "req-1", "http://localhost:54545/other");
      expect((yield* browser.next("Fetch.continueRequest")).params).toEqual({
        requestId: "req-1",
      });
      expect(commands(browser.sent, "Fetch.fulfillRequest")).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.live("fails the wait when the browser goes away first", () =>
    Effect.gen(function* () {
      const browser = yield* fakeBrowser;
      const opening = yield* Effect.forkScoped(
        catchSignIn(browser.socket, { loginUrl: LOGIN, redirect: REDIRECT }),
      );
      yield* browser.next("Target.setAutoAttach");
      yield* browser.attach("page-1", "page", false);
      const { redirected } = yield* Fiber.join(opening);
      yield* browser.close;
      const error = yield* Effect.flip(redirected);
      expect(error.message).toBe("The sign-in browser closed.");
    }).pipe(Effect.scoped),
  );
});
