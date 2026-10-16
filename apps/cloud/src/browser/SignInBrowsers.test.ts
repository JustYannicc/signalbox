import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Socket from "effect/socket/Socket";

import { KernelApiError } from "./KernelApi.ts";
import { memoryKernel } from "./memoryKernel.ts";
import * as SignInBrowsers from "./SignInBrowsers.ts";

const LOGIN =
  "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=s";

/** A CDP endpoint that attaches its one page as soon as it's asked to. */
const answeringBrowser = (connected: Array<string>) => (url: string) =>
  Effect.gen(function* () {
    connected.push(url);
    const incoming = yield* Queue.unbounded<string>();
    return Socket.make({
      reader: Effect.succeed({
        pull: Effect.map(Queue.take(incoming), (frame) => [frame] as const),
        upgrade: () => Effect.void,
      }),
      writer: Effect.succeed({
        write: (chunk) =>
          Effect.sync(() => {
            if (typeof chunk !== "string" || !chunk.includes("Target.setAutoAttach")) return;
            Queue.offerUnsafe(
              incoming,
              JSON.stringify({
                method: "Target.attachedToTarget",
                params: { sessionId: "page", targetInfo: { type: "page" } },
              }),
            );
          }),
        writeAll: () => Effect.void,
      }),
    });
  });

describe("SignInBrowsers", () => {
  it.effect("opens a fresh headful browser for the login and deletes it afterwards", () =>
    Effect.gen(function* () {
      const kernel = memoryKernel();
      const connected: Array<string> = [];
      const browsers = SignInBrowsers.make(kernel.api, answeringBrowser(connected));
      const scope = yield* Scope.make();
      const browser = yield* Scope.provide(browsers.open(LOGIN), scope);

      expect(browser).toMatchObject({
        liveViewUrl: "https://live.test/browser-1",
        site: "auth.openai.com",
      });
      expect(connected).toEqual(["wss://cdp.test/browser-1"]);
      // No profile: a second account must not find the first one signed in.
      expect(kernel.created).toEqual([
        {
          stealth: true,
          headless: false,
          kiosk_mode: true,
          viewport: SignInBrowsers.SIGN_IN_VIEWPORT,
          timeout_seconds: SignInBrowsers.SIGN_IN_TIMEOUT_SECONDS,
          tags: { signalbox_purpose: "pool_sign_in" },
        },
      ]);
      yield* Scope.close(scope, Exit.void);
      expect(kernel.deleted).toEqual(["browser-1"]);
    }),
  );

  it.effect("has nothing to open without Kernel, or for a login without a localhost redirect", () =>
    Effect.gen(function* () {
      const kernel = memoryKernel();
      const none = SignInBrowsers.make(null, answeringBrowser([]));
      expect(yield* Effect.scoped(none.open(LOGIN))).toBeNull();
      const some = SignInBrowsers.make(kernel.api, answeringBrowser([]));
      expect(yield* Effect.scoped(some.open("https://claude.ai/device?code=x"))).toBeNull();
      expect(kernel.created).toEqual([]);
    }),
  );

  it.effect("says plainly when Kernel refuses, so a plan limit is obvious", () =>
    Effect.gen(function* () {
      const kernel = memoryKernel();
      kernel.refuseWith(
        new KernelApiError({
          operation: "createBrowser",
          status: 429,
          code: "org_limit_exceeded",
          message: "Concurrent browser limit reached.",
        }),
      );
      const browsers = SignInBrowsers.make(kernel.api, answeringBrowser([]));
      const error = yield* Effect.flip(Effect.scoped(browsers.open(LOGIN)));
      expect(error.message).toBe(
        "Kernel couldn't open a sign-in browser: Concurrent browser limit reached (org_limit_exceeded, HTTP 429).",
      );
    }),
  );
});
