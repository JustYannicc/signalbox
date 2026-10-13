import {
  ACCOUNT_AUTHORIZE_PATH,
  ACCOUNT_HANDOFF_PATH,
  ACCOUNT_SESSION_PATH,
  AccountHandoffFailure,
  AccountHandoffResult,
  AccountSessionState,
  AccountSignInError,
  type AccountAuthorizeParams,
  type AccountHandoffRequest,
} from "@t3tools/contracts/account";
import * as Schema from "effect/Schema";

/**
 * Client side of Signalbox accounts, shared by web, desktop and mobile.
 * Platforms bring their own navigation (location, system browser, auth
 * session) and PKCE hashing; everything that must agree with the server
 * lives here.
 */

const decodeSessionState = Schema.decodeUnknownSync(AccountSessionState);
const decodeHandoffResult = Schema.decodeUnknownSync(AccountHandoffResult);
const isSignInError = Schema.is(AccountSignInError);

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Absolute URL a client opens to start sign-in on `params.origin`. */
export function buildAccountAuthorizeUrl(params: AccountAuthorizeParams): string {
  const url = new URL(`${trimTrailingSlash(params.origin)}${ACCOUNT_AUTHORIZE_PATH}`);
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string" && value.length > 0) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Reads `GET /api/account/session`. Defaults to `credentials: "include"` for
 * same-origin cookie sessions. Cross-origin bearer clients (packaged desktop)
 * pass `credentials: "omit"` plus an `Authorization` header, because the
 * server's production CORS does not allow credentialed requests.
 */
export async function fetchAccountSessionState(
  origin: string,
  init?: {
    readonly headers?: HeadersInit;
    readonly credentials?: RequestCredentials;
    readonly fetch?: typeof fetch;
  },
): Promise<AccountSessionState> {
  const response = await (init?.fetch ?? fetch)(
    `${trimTrailingSlash(origin)}${ACCOUNT_SESSION_PATH}`,
    {
      credentials: init?.credentials ?? "include",
      ...(init?.headers ? { headers: init.headers } : {}),
    },
  );
  if (!response.ok) throw new Error(`Account session request failed (${response.status}).`);
  return decodeSessionState(await response.json());
}

/** A handoff the server refused, with the code to show the user. */
export class AccountHandoffError extends Error {
  readonly code: AccountSignInError;
  constructor(code: AccountSignInError) {
    super(`Sign-in handoff failed: ${code}.`);
    this.name = "AccountHandoffError";
    this.code = code;
  }
}

/** Redeems a native-mode handoff for a one-time pairing credential. Throws `AccountHandoffError`. */
export async function redeemAccountHandoff(
  origin: string,
  request: AccountHandoffRequest,
  init?: { readonly fetch?: typeof fetch },
): Promise<AccountHandoffResult> {
  const response = await (init?.fetch ?? fetch)(
    `${trimTrailingSlash(origin)}${ACCOUNT_HANDOFF_PATH}`,
    {
      method: "POST",
      credentials: "omit",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    },
  );
  if (response.ok) return decodeHandoffResult(await response.json());
  if (response.status === 404) throw new AccountHandoffError("expired");
  const body: unknown = await response.json().catch(() => null);
  throw new AccountHandoffError(
    isHandoffFailure(body) && isSignInError(body.error) ? body.error : "failed",
  );
}

const isHandoffFailure = Schema.is(AccountHandoffFailure);

export type AccountReturn =
  | { readonly _tag: "handoff"; readonly handoff: string }
  | { readonly _tag: "error"; readonly error: AccountSignInError };

/** Parses `?handoff=` / `?error=` from a native return URL or the `/sign-in` page URL. */
export function parseAccountReturn(url: string | URL): AccountReturn | null {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const handoff = parsed.searchParams.get("handoff");
  if (handoff) return { _tag: "handoff", handoff };
  const error = parsed.searchParams.get("error");
  if (error === null) return null;
  return { _tag: "error", error: isSignInError(error) ? error : "failed" };
}
