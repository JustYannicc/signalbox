import {
  fetchAccountSessionState,
  startGitHubNativeConnect,
} from "@t3tools/client-runtime/account";
import {
  ACCOUNT_SIGN_OUT_PATH,
  type AccountProfile,
  type AccountSessionState,
} from "@t3tools/contracts/account";

const REQUEST_TIMEOUT_MS = 10_000;

/** fetch with a deadline; RN's fetch never gives up on a silent host. */
function fetchWithTimeout(status: { current: number | null }, timeoutMs: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      status.current = response.status;
      return response;
    } finally {
      clearTimeout(timeout);
    }
  };
}

export type ServerAccountCheck =
  | { readonly _tag: "accounts"; readonly session: AccountSessionState }
  /** Accounts are off or unconfigured, or the server predates them: pair with a code instead. */
  | { readonly _tag: "pairing" };

/** Asks a server whether it signs people in with accounts. Throws when unreachable. */
export async function checkServerAccounts(serverUrl: string): Promise<ServerAccountCheck> {
  const status = { current: null as number | null };
  try {
    const session = await fetchAccountSessionState(serverUrl, {
      fetch: fetchWithTimeout(status, REQUEST_TIMEOUT_MS),
    });
    // A server with accounts on but no sign-in option configured can still pair.
    return session.enabled && session.providers.length > 0
      ? { _tag: "accounts", session }
      : { _tag: "pairing" };
  } catch (error) {
    // A Signalbox or T3 Code server without the account routes answers 404.
    if (status.current === 404) return { _tag: "pairing" };
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
    fetch: fetchWithTimeout({ current: null }, REQUEST_TIMEOUT_MS),
  });
  return session.enabled ? session.account : null;
}

/** `POST /api/account/sign-out` with the environment's own bearer session. */
export async function signOutAccount(httpBaseUrl: string, token: string): Promise<void> {
  const response = await fetchWithTimeout({ current: null }, REQUEST_TIMEOUT_MS)(
    `${httpBaseUrl.replace(/\/+$/, "")}${ACCOUNT_SIGN_OUT_PATH}`,
    { method: "POST", headers: bearerHeaders(token) },
  );
  if (!response.ok) throw new Error(`Sign-out failed (${response.status}).`);
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
  const status = { current: null as number | null };
  let link: string;
  try {
    link = await startGitHubNativeConnect(httpBaseUrl, token, returnUrl, {
      fetch: fetchWithTimeout(status, REQUEST_TIMEOUT_MS),
    });
  } catch {
    if (status.current === null) {
      throw new Error("Couldn’t reach Signalbox to connect GitHub. Try again.");
    }
    if (status.current < 200 || status.current >= 300) {
      throw new Error(`Couldn’t start connecting GitHub (${status.current}).`);
    }
    // A 2xx the shared helper couldn’t decode: no link to open.
    link = "";
  }
  const url = parseUrl(link);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error("Signalbox sent a connect link this app can’t open.");
  }
  return url.toString();
}

/** How connecting ended, from `?github=` on the return URL. Anything else counts as failed. */
export function parseGitHubConnectReturn(url: string): "connected" | "cancelled" | "failed" {
  const outcome = parseUrl(url)?.searchParams.get("github");
  return outcome === "connected" || outcome === "cancelled" ? outcome : "failed";
}
