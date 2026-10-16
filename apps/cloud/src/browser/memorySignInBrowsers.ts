import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { SIGN_IN_VIEWPORT, SignInBrowserError, SignInBrowsers } from "./SignInBrowsers.ts";
import { redirectTarget } from "./signInCatch.ts";

interface OpenedBrowser {
  readonly loginUrl: string;
  readonly liveViewUrl: string;
  readonly redirect: Deferred.Deferred<string, SignInBrowserError>;
  closed: boolean;
}

/**
 * For tests: sign-in browsers in memory. `land` is the provider redirecting
 * the browser once the person signed in; `goAway` is the browser closing
 * first.
 */
export const memorySignInBrowsers = () => {
  const opened: Array<OpenedBrowser> = [];
  let refusal: string | null = null;
  const service = SignInBrowsers.of({
    open: (loginUrl) =>
      Effect.gen(function* () {
        if (redirectTarget(loginUrl) === null) return null;
        if (refusal !== null) return yield* new SignInBrowserError({ message: refusal });
        const redirect = yield* Deferred.make<string, SignInBrowserError>();
        const browser: OpenedBrowser = {
          loginUrl,
          liveViewUrl: `https://live.kernel.test/${opened.length + 1}`,
          redirect,
          closed: false,
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => opened.push(browser)),
          () => Effect.sync(() => (browser.closed = true)),
        );
        return {
          liveViewUrl: browser.liveViewUrl,
          site: new URL(loginUrl).hostname,
          viewport: SIGN_IN_VIEWPORT,
          redirected: Deferred.await(redirect),
        };
      }),
  });
  const last = () => {
    const browser = opened.at(-1);
    if (!browser) throw new Error("No sign-in browser was opened.");
    return browser;
  };
  return {
    service,
    opened,
    /** The last browser's login redirecting to its `localhost` address with `code`. */
    land: (code = "code-1") =>
      Effect.suspend(() => {
        const browser = last();
        const login = new URL(browser.loginUrl);
        const redirect = new URL(login.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("code", code);
        redirect.searchParams.set("state", login.searchParams.get("state") ?? "");
        return Deferred.succeed(browser.redirect, redirect.toString());
      }),
    goAway: Effect.suspend(() =>
      Deferred.fail(
        last().redirect,
        new SignInBrowserError({ message: "The sign-in browser closed." }),
      ),
    ),
    refuseWith: (message: string | null) => {
      refusal = message;
    },
  };
};
