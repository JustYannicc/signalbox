import {
  ACCOUNT_AUTHORIZE_PATH,
  AccountSignInError,
  type AccountAuthorizeParams,
  type AccountHandoffRequest,
  type AccountHandoffResult,
  type AccountSessionState,
} from "@t3tools/contracts/account";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import { AccountClient, layer as accountClientLayer, useAccountClient } from "./client.ts";

export * from "./client.ts";
export * from "./errors.ts";

/** Absolute URL a client opens to start sign-in on `params.origin`. */
export function buildAccountAuthorizeUrl(params: AccountAuthorizeParams): string {
  const origin = params.origin.endsWith("/") ? params.origin.slice(0, -1) : params.origin;
  const url = new URL(`${origin}${ACCOUNT_AUTHORIZE_PATH}`);
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 0) url.searchParams.set(key, value);
  }
  return url.toString();
}

export type AccountReturn =
  | { readonly _tag: "handoff"; readonly handoff: string }
  | { readonly _tag: "error"; readonly error: AccountSignInError };

const isSignInError = Schema.is(AccountSignInError);

/** Parses `?handoff=` / `?error=` from a native return URL or the `/sign-in` page URL. */
export function parseAccountReturn(url: string | URL): AccountReturn | null {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const handoff = parsed.searchParams.get("handoff");
  if (handoff) return { _tag: "handoff", handoff };
  const error = parsed.searchParams.get("error");
  if (error === null) return null;
  return { _tag: "error", error: isSignInError(error) ? error : "failed" };
}

/** Runs an account effect in the current web or native fetch environment. */
export const runAccountClient = <A, E>(
  effect: Effect.Effect<A, E, AccountClient>,
  options?: { readonly fetch?: typeof globalThis.fetch },
): Promise<A> => {
  const fetchLayer = FetchHttpClient.layer.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, options?.fetch ?? globalThis.fetch)),
  );
  const layer = accountClientLayer.pipe(Layer.provide(fetchLayer));
  return Effect.runPromise(effect.pipe(Effect.provide(layer)));
};

export function fetchAccountSessionState(
  origin: string,
  init?: {
    readonly headers?: HeadersInit;
    readonly credentials?: RequestCredentials;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  },
): Promise<AccountSessionState> {
  return runAccountClient(
    useAccountClient((client) =>
      client.fetchSession({
        origin,
        ...(init?.headers === undefined ? {} : { headers: init.headers }),
        ...(init?.credentials === undefined ? {} : { credentials: init.credentials }),
        ...(init?.timeoutMs === undefined ? {} : { timeoutMs: init.timeoutMs }),
      }),
    ),
    init?.fetch === undefined ? undefined : { fetch: init.fetch },
  );
}

/** Redeems a native-mode handoff for a one-time pairing credential. */
export function redeemAccountHandoff(
  origin: string,
  request: AccountHandoffRequest,
  init?: { readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number },
): Promise<AccountHandoffResult> {
  return runAccountClient(
    useAccountClient((client) =>
      client.redeemHandoff({
        origin,
        request,
        ...(init?.timeoutMs === undefined ? {} : { timeoutMs: init.timeoutMs }),
      }),
    ),
    init?.fetch === undefined ? undefined : { fetch: init.fetch },
  );
}

/** Requests sign-out for the account that owns `origin`. */
export function signOutAccountSession(
  origin: string,
  init?: {
    readonly headers?: HeadersInit;
    readonly credentials?: RequestCredentials;
    readonly fetch?: typeof globalThis.fetch;
    readonly timeoutMs?: number;
  },
): Promise<void> {
  return runAccountClient(
    useAccountClient((client) =>
      client.signOut({
        origin,
        ...(init?.headers === undefined ? {} : { headers: init.headers }),
        ...(init?.credentials === undefined ? {} : { credentials: init.credentials }),
        ...(init?.timeoutMs === undefined ? {} : { timeoutMs: init.timeoutMs }),
      }),
    ),
    init?.fetch === undefined ? undefined : { fetch: init.fetch },
  );
}

/** Requests the one-time GitHub connection link used by the native auth session. */
export function startGitHubNativeConnect(
  origin: string,
  token: string,
  returnUrl: string,
  init?: { readonly fetch?: typeof globalThis.fetch; readonly timeoutMs?: number },
): Promise<string> {
  return runAccountClient(
    useAccountClient((client) =>
      client.startGitHubNativeConnect({
        origin,
        token,
        returnUrl,
        ...(init?.timeoutMs === undefined ? {} : { timeoutMs: init.timeoutMs }),
      }),
    ),
    init?.fetch === undefined ? undefined : { fetch: init.fetch },
  );
}
