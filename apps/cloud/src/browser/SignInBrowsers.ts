import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import type * as Scope from "effect/Scope";
import * as Socket from "effect/socket/Socket";

import { refusalFor } from "./browserPolicy.ts";
import { type KernelApi, type KernelApiError, kernelApiFromEnv } from "./KernelApi.ts";
import { catchSignIn, redirectTarget, SignInBrowserError } from "./signInCatch.ts";

export { SignInBrowserError };

/**
 * Pool sign-ins in a cloud browser (#205). A provider login that ends on a
 * `localhost` redirect opens in its own headful Kernel browser, which the
 * person signs in through on any client via its live view. The redirect is
 * caught inside that browser (`signInCatch.ts`) and handed to the pool, so
 * nobody copies or pastes anything.
 *
 * Every sign-in gets a fresh browser with no profile: adding a second account
 * must not find the first one already signed in. The browser lives as long as
 * the scope it was opened in. Without `KERNEL_API_KEY` there is none, and the
 * person signs in in their own browser as before. Live view and CDP URLs are
 * credentials: handed on, never logged.
 */

export interface SignInBrowser {
  /** For the person's clients to embed. */
  readonly liveViewUrl: string;
  /** The sign-in page's host, such as `claude.ai`. */
  readonly site: string;
  /** The address the login redirected to once the person signed in. */
  readonly redirected: Effect.Effect<string, SignInBrowserError>;
}

export class SignInBrowsers extends Context.Service<
  SignInBrowsers,
  {
    /** Null without Kernel, or for a login that doesn't end on a `localhost` redirect. */
    readonly open: (
      loginUrl: string,
    ) => Effect.Effect<SignInBrowser | null, SignInBrowserError, Scope.Scope>;
  }
>()("@signalbox/cloud/browser/SignInBrowsers") {}

/** Kernel's phone size, so the page fits a phone 1:1 and a dialog on a computer. */
export const SIGN_IN_VIEWPORT = { width: 390, height: 844 } as const;
/** Kernel deletes the browser this long after its last live view or CDP activity. */
export const SIGN_IN_TIMEOUT_SECONDS = 300;

const opens = Metric.counter("signalbox_cloud_sign_in_browser_opens_total", {
  description: "Cloud browsers opened for pool sign-ins, by outcome.",
});
const countOpen = (outcome: "opened" | "refused" | "failed" | "unconfigured" | "no_redirect") =>
  Metric.update(Metric.withAttributes(opens, { outcome }), 1);

/** Kernel's own words, so a plan's limit shows plainly. */
const refused = (error: KernelApiError) =>
  new SignInBrowserError({ message: refusalFor(error, "a sign-in browser") });

export const make = (
  kernel: KernelApi | null,
  connect: (cdpWsUrl: string) => Effect.Effect<Socket.Socket>,
) =>
  SignInBrowsers.of({
    open: Effect.fn("SignInBrowsers.open")(function* (loginUrl: string) {
      if (kernel === null) {
        yield* countOpen("unconfigured");
        return null;
      }
      const redirect = redirectTarget(loginUrl);
      if (redirect === null) {
        yield* countOpen("no_redirect");
        return null;
      }
      const browser = yield* Effect.acquireRelease(
        kernel.createBrowser({
          stealth: true,
          headless: false,
          kiosk_mode: true,
          viewport: SIGN_IN_VIEWPORT,
          timeout_seconds: SIGN_IN_TIMEOUT_SECONDS,
          tags: { signalbox_purpose: "pool_sign_in" },
        }),
        (opened) => kernel.deleteBrowser(opened.session_id).pipe(Effect.ignore),
      ).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Kernel refused a sign-in browser", {
            status: error.status,
            code: error.code,
          }).pipe(Effect.andThen(countOpen("refused"))),
        ),
        Effect.mapError(refused),
      );
      const { liveViewUrl, redirected } = yield* Effect.gen(function* () {
        const liveViewUrl = browser.browser_live_view_url;
        if (!liveViewUrl) {
          return yield* new SignInBrowserError({
            message: "Kernel's sign-in browser has no live view.",
          });
        }
        const socket = yield* connect(browser.cdp_ws_url);
        const { redirected } = yield* catchSignIn(socket, { loginUrl, redirect });
        return { liveViewUrl, redirected };
      }).pipe(Effect.tapError(() => countOpen("failed")));
      yield* countOpen("opened");
      return { liveViewUrl, site: new URL(loginUrl).hostname, redirected };
    }),
  });

/** On `kernel`, or with no sign-in browser when it's null. */
export const layer = (
  kernel: KernelApi | null,
  connect: (cdpWsUrl: string) => Effect.Effect<Socket.Socket> = (url) =>
    Socket.makeWebSocket(url, { openTimeout: "10 seconds" }).pipe(
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
    ),
) => Layer.succeed(SignInBrowsers, make(kernel, connect));

/** Kernel with this cloud's key, or no sign-in browser without one. */
export const layerFromEnv = (env: { readonly KERNEL_API_KEY?: string }) =>
  Layer.unwrap(Effect.map(kernelApiFromEnv(env), (kernel) => layer(kernel)));
