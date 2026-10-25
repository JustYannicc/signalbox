import {
  fetchAccountSessionState,
  isAccountHttpStatusError,
  isAccountResponseDecodeError,
  signOutAccountSession,
  startGitHubNativeConnect,
} from "@t3tools/client-runtime/account";
import type { AccountProfile, AccountSessionState } from "@t3tools/contracts/account";
import * as Schema from "effect/Schema";

const REQUEST_TIMEOUT_MS = 10_000;

const GitHubConnectFailure = Schema.Literals(["unreachable", "rejected", "invalid-link"]);

class AccountGitHubConnectError extends Schema.TaggedError<AccountGitHubConnectError>()(
  "AccountGitHubConnectError",
  {
    reason: GitHubConnectFailure,
    status: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unreachable":
        return "Couldn’t reach Signalbox to connect GitHub. Try again.";
      case "rejected":
        return `Couldn’t start connecting GitHub (${this.status}).`;
      case "invalid-link":
        return "Signalbox sent a connect link this app can’t open.";
    }
  }
}

export type ServerAccountCheck =
  | { readonly _tag: "accounts"; readonly session: AccountSessionState }
  /** Accounts are off or unconfigured, or the server predates them: pair with a code instead. */
  | { readonly _tag: "pairing" };

/** Asks a server whether it signs people in with accounts. Throws when unreachable. */
export async function checkServerAccounts(serverUrl: string): Promise<ServerAccountCheck> {
  try {
    const session = await fetchAccountSessionState(serverUrl, { timeoutMs: REQUEST_TIMEOUT_MS });
    // A server with accounts on but no sign-in option configured can still pair.
    return session.enabled && session.providers.length > 0
      ? { _tag: "accounts", session }
      : { _tag: "pairing" };
  } catch (error) {
    // A Signalbox or T3 Code server without the account routes answers 404.
    if (isAccountHttpStatusError(error) && error.status === 404) return { _tag: "pairing" };
    throw error;
  }
}

function bearerHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** The account behind an environment session, or null for a paired or cookie session. */
export async function fetchEnvironmentAccount(
  httpBaseUrl: string,
  token: string,
): Promise<AccountProfile | null> {
  const session = await fetchAccountSessionState(httpBaseUrl, {
    headers: bearerHeaders(token),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  return session.enabled ? session.account : null;
}

/** `POST /api/account/sign-out` with the environment's own bearer session. */
export async function signOutAccount(httpBaseUrl: string, token: string): Promise<void> {
  await signOutAccountSession(httpBaseUrl, {
    headers: bearerHeaders(token),
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Asks the environment, with its own bearer session, for a one-time link that connects this
 * person's GitHub in a browser and comes back to `returnUrl`. Throws with a message fit to show.
 */
export async function startGitHubConnect(
  httpBaseUrl: string,
  token: string,
  returnUrl: string,
): Promise<string> {
  let link: string;
  try {
    link = await startGitHubNativeConnect(httpBaseUrl, token, returnUrl, {
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    if (isAccountHttpStatusError(error)) {
      throw new AccountGitHubConnectError({ reason: "rejected", status: error.status });
    }
    if (isAccountResponseDecodeError(error)) {
      link = "";
    } else {
      throw new AccountGitHubConnectError({ reason: "unreachable" });
    }
  }
  const url = parseUrl(link);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new AccountGitHubConnectError({ reason: "invalid-link" });
  }
  return url.toString();
}

/** How connecting ended, from `?github=` on the return URL. Anything else counts as failed. */
export function parseGitHubConnectReturn(url: string): "connected" | "cancelled" | "failed" {
  const outcome = parseUrl(url)?.searchParams.get("github");
  return outcome === "connected" || outcome === "cancelled" ? outcome : "failed";
}
