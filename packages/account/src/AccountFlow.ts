// @effect-diagnostics-next-line nodeBuiltinImport:off -- PKCE verifier and challenge are built synchronously.
import * as NodeCrypto from "node:crypto";

import {
  ACCOUNT_CALLBACK_PATH,
  ACCOUNT_NATIVE_RETURN_SCHEMES,
  ACCOUNT_SIGN_IN_ROUTE,
  AccountProvider,
  type AccountAuthorizeParams,
  type AccountSignInError,
} from "@t3tools/contracts/account";
import * as Result from "effect/Result";

/**
 * Pure pieces of the sign-in flow: input validation, PKCE, and the WorkOS
 * authorize URL. Everything here is deterministic apart from the random
 * helpers, so the service keeps only state and I/O.
 */

/** WorkOS `provider` value per sign-in option. */
const WORKOS_PROVIDERS = {
  google: "GoogleOAuth",
  github: "GitHubOAuth",
  apple: "AppleOAuth",
  email: "authkit",
} as const satisfies Record<AccountProvider, string>;

export type AccountReturnTarget =
  | { readonly mode: "browser"; readonly returnTo: string }
  | ({ readonly mode: "native"; readonly challenge: string } & NativeReturn);

/** Where a native attempt reports back. Validated before it is ever stored. */
export interface NativeReturn {
  readonly returnUrl: string;
  /** Report to `<origin>/sign-in?…&returnUrl=` instead of jumping to the app. */
  readonly via?: "web";
}

export interface ValidatedAuthorizeRequest {
  readonly provider: AccountProvider;
  /** Normalized origin, no trailing slash. */
  readonly origin: string;
  readonly loginHint?: string;
  readonly screenHint?: "sign-in" | "sign-up";
  readonly selectAccount: boolean;
  readonly target: AccountReturnTarget;
}

const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** `origin` must be a bare http(s) origin; a trailing slash is tolerated. */
function normalizeOrigin(value: string): string | null {
  const url = parseUrl(value);
  if (url === null || (url.protocol !== "http:" && url.protocol !== "https:")) return null;
  return value === url.origin || value === `${url.origin}/` ? url.origin : null;
}

/** Same-origin path only. `//host` and `/\host` are protocol-relative to browsers. */
function isSameOriginPath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.startsWith("/\\") &&
    ![...value].some((character) => character <= "\u001f" || character === "\u007f")
  );
}

function isNativeReturnUrl(value: string): boolean {
  const url = parseUrl(value);
  return (
    url !== null &&
    (ACCOUNT_NATIVE_RETURN_SCHEMES as ReadonlyArray<string>).includes(url.protocol.toLowerCase())
  );
}

export function validateAuthorizeParams(
  params: AccountAuthorizeParams,
): Result.Result<ValidatedAuthorizeRequest, string> {
  const origin = normalizeOrigin(params.origin);
  if (origin === null) return Result.fail("origin must be an absolute http(s) origin");

  let target: AccountReturnTarget;
  if (params.via !== undefined && params.mode !== "native") {
    return Result.fail("via=web requires native mode");
  }
  if (params.mode === "browser") {
    const returnTo = params.returnTo ?? "/";
    if (!isSameOriginPath(returnTo)) return Result.fail("returnTo must be a same-origin path");
    target = { mode: "browser", returnTo };
  } else {
    if (params.returnUrl === undefined || !isNativeReturnUrl(params.returnUrl)) {
      return Result.fail("returnUrl must use a Signalbox app scheme");
    }
    if (params.challenge === undefined || !BASE64URL_SHA256.test(params.challenge)) {
      return Result.fail("challenge must be base64url(SHA-256(verifier))");
    }
    target = {
      mode: "native",
      returnUrl: params.returnUrl,
      challenge: params.challenge,
      ...(params.via ? { via: params.via } : {}),
    };
  }

  return Result.succeed({
    provider: params.provider,
    origin,
    ...(params.loginHint && params.provider === "email" ? { loginHint: params.loginHint } : {}),
    ...(params.screenHint && params.provider === "email" ? { screenHint: params.screenHint } : {}),
    selectAccount: params.selectAccount === "1",
    target,
  });
}

/** 256 bits of randomness, base64url. Used for state, verifiers, and handoff ids. */
export function randomToken(): string {
  return NodeCrypto.randomBytes(32).toString("base64url");
}

/**
 * OAuth `state` for an attempt: `<nonce>` for browser mode, and
 * `<nonce>.<base64url(returnUrl)>[.web]` for native mode so an expired or
 * unknown state can still report back (`nativeReturnFromState`). The random
 * nonce is what binds the attempt; the rest only says where errors go.
 */
export function attemptState(target: AccountReturnTarget): string {
  const nonce = randomToken();
  if (target.mode !== "native") return nonce;
  const returnUrl = Buffer.from(target.returnUrl).toString("base64url");
  return `${nonce}.${returnUrl}${target.via === "web" ? ".web" : ""}`;
}

/** The native return encoded in `state`, only if it still passes validation. */
export function nativeReturnFromState(state: string | undefined): NativeReturn | undefined {
  const [, encoded, via, ...rest] = state?.split(".") ?? [];
  if (encoded === undefined || rest.length > 0 || (via !== undefined && via !== "web")) {
    return undefined;
  }
  const returnUrl = Buffer.from(encoded, "base64url").toString("utf8");
  if (!isNativeReturnUrl(returnUrl)) return undefined;
  return via === "web" ? { returnUrl, via } : { returnUrl };
}

/**
 * Where a native attempt's `handoff` or `error` goes: straight to the app, or
 * for `via: "web"` to the sign-in page, which opens the app itself. Without an
 * origin (state expired, attempt unknown) the page URL is relative.
 */
export function nativeReturnLocation(
  native: NativeReturn,
  origin: string | undefined,
  params: Readonly<Record<string, string>>,
): string {
  if (native.via !== "web") return withQuery(native.returnUrl, params);
  const query = new URLSearchParams({ ...params, returnUrl: native.returnUrl });
  return `${origin ?? ""}${ACCOUNT_SIGN_IN_ROUTE}?${query.toString()}`;
}

/** RFC 7636 S256 challenge. */
export function pkceChallenge(verifier: string): string {
  return NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
}

function accountCallbackUrl(origin: string): string {
  return `${origin}${ACCOUNT_CALLBACK_PATH}`;
}

export function buildWorkOSAuthorizeUrl(input: {
  readonly apiBaseUrl: string;
  readonly clientId: string;
  readonly request: ValidatedAuthorizeRequest;
  readonly state: string;
  readonly codeChallenge: string;
}): string {
  const { request } = input;
  const provider = WORKOS_PROVIDERS[request.provider];
  const url = new URL("/user_management/authorize", input.apiBaseUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", accountCallbackUrl(request.origin));
  url.searchParams.set("provider", provider);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (request.loginHint) url.searchParams.set("login_hint", request.loginHint);
  if (request.screenHint) url.searchParams.set("screen_hint", request.screenHint);
  if (request.selectAccount) {
    // `max_age` only works for AuthKit; social providers take their own
    // parameter through `provider_query_params[...]` (bracket encoding, as the
    // WorkOS SDKs send it). GitHub and Apple have no account picker to force.
    if (provider === "authkit") url.searchParams.set("max_age", "0");
    else if (provider === "GoogleOAuth") {
      url.searchParams.set("provider_query_params[prompt]", "select_account");
    }
  }
  return url.toString();
}

/** Where a failed browser sign-in lands. Relative so it follows the client's origin. */
function browserErrorLocation(error: AccountSignInError): string {
  return `${ACCOUNT_SIGN_IN_ROUTE}?${new URLSearchParams({ error }).toString()}`;
}

/** Native return URL with the given query params set. */
function withQuery(base: string, params: Readonly<Record<string, string>>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

/** Where a failed callback sends the user: the native return, or `/sign-in`. */
export function callbackErrorLocation(
  input: { readonly origin: string; readonly target: AccountReturnTarget },
  error: AccountSignInError,
): string {
  return input.target.mode === "native"
    ? nativeReturnLocation(input.target, input.origin, { error })
    : browserErrorLocation(error);
}

/** An unknown state can still name a validated native return; it has no origin. */
export function expiredCallbackLocation(state: string | undefined): string {
  const native = nativeReturnFromState(state);
  return native
    ? nativeReturnLocation(native, undefined, { error: "expired" })
    : browserErrorLocation("expired");
}

/** The sign-in page's email-code step for a paused sign-in, on the client's origin. */
export function verifyEmailLocation(origin: string, verify: string, email: string): string {
  const query = new URLSearchParams({ verify, email });
  return `${origin}${ACCOUNT_SIGN_IN_ROUTE}?${query.toString()}`;
}
