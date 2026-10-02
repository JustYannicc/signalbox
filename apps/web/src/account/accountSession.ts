import {
  buildAccountAuthorizeUrl,
  fetchAccountSessionState,
} from "@t3tools/client-runtime/account";
import {
  ACCOUNT_SIGN_IN_ROUTE,
  ACCOUNT_SIGN_OUT_PATH,
  type AccountProvider,
  type AccountSessionState,
} from "@t3tools/contracts/account";
import { redirect } from "@tanstack/react-router";

import { decideAccountGate, sanitizeReturnTo } from "./accountGate";
import { isDesktop, primaryOrigin, reloadAt, requirePrimaryOrigin } from "./accountPlatform";
import { clearDesktopAccountToken, readDesktopAccountToken } from "./desktopAccount";

export { AccountFlowError, isDesktop } from "./accountPlatform";
export { cancelNativeSignIn, completeNativeSignIn, startNativeSignIn } from "./desktopAccount";

/**
 * Signalbox account state and transitions for web and desktop.
 *
 * Every transition (sign-in done, sign-out) ends in a full page load, so the
 * session read once per page is the truth for that page and nothing has to
 * invalidate it. Browser sign-in rides the cookie the callback sets; desktop
 * presents its account bearer (see `desktopAccount.ts`).
 */

interface AccountRequestInit {
  readonly headers?: HeadersInit;
  readonly credentials: RequestCredentials;
}

/**
 * Account routes: the browser cookie, or on desktop no cookies and the account
 * bearer. Never the desktop's own session: sign-out must not end it.
 */
function accountRequestInit(): AccountRequestInit {
  if (!isDesktop()) return { credentials: "include" };
  const token = readDesktopAccountToken();
  return token
    ? { credentials: "omit", headers: { authorization: `Bearer ${token}` } }
    : { credentials: "omit" };
}

// --- session state ----------------------------------------------------------

let resolvedSession: AccountSessionState | null = null;
let unsupported = false;
let inflight: Promise<AccountSessionState | null> | null = null;

/**
 * The primary environment's account state, read once per page load. `null`
 * means unknown (no primary, old server, request failed): callers fall back to
 * the pairing gate.
 */
function loadAccountSession(): Promise<AccountSessionState | null> {
  if (resolvedSession || unsupported) return Promise.resolve(resolvedSession);
  inflight ??= fetchPrimaryAccountSession()
    .then(
      (session) => {
        resolvedSession = session;
        return session;
      },
      () => null,
    )
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

async function fetchPrimaryAccountSession(): Promise<AccountSessionState | null> {
  const origin = primaryOrigin();
  if (!origin) {
    unsupported = true;
    return null;
  }
  const { credentials, headers } = accountRequestInit();
  const session = await fetchAccountSessionState(origin, {
    credentials,
    ...(headers ? { headers } : {}),
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      // Servers without accounts don't have the route; stop asking this page.
      if (response.status === 404) unsupported = true;
      return response;
    },
  });
  // A stale or revoked desktop account token reads as signed out: drop it.
  if (isDesktop() && session.enabled && session.account === null && readDesktopAccountToken()) {
    clearDesktopAccountToken();
  }
  return session;
}

/** Synchronous read for components; root `beforeLoad` has already loaded it. */
export function readAccountSession(): AccountSessionState | null {
  return resolvedSession;
}

/** Root `beforeLoad` hook: a redirect to throw, or null. Never rejects. */
export async function resolveAccountRedirect(location: {
  readonly pathname: string;
  readonly href: string;
}) {
  const decision = decideAccountGate({ ...location, session: await loadAccountSession() });
  switch (decision._tag) {
    case "allow":
      return null;
    case "leave-sign-in":
      return redirect({ to: "/", replace: true });
    case "sign-in":
      return redirect({
        to: ACCOUNT_SIGN_IN_ROUTE,
        search: decision.returnTo ? { returnTo: decision.returnTo } : {},
        replace: true,
      });
  }
}

// --- sign in ----------------------------------------------------------------

export interface StartAccountSignInInput {
  readonly provider: AccountProvider;
  readonly loginHint?: string;
  readonly selectAccount?: boolean;
  readonly returnTo?: string;
}

/** Browser sign-in: navigate to the authorize route; the callback brings us back signed in. */
export function startAccountSignIn(input: StartAccountSignInInput): void {
  const returnTo = sanitizeReturnTo(input.returnTo);
  window.location.assign(
    buildAccountAuthorizeUrl({
      provider: input.provider,
      origin: requirePrimaryOrigin(),
      mode: "browser",
      ...(input.loginHint ? { loginHint: input.loginHint } : {}),
      ...(input.selectAccount ? { selectAccount: "1" as const } : {}),
      ...(returnTo ? { returnTo } : {}),
    }),
  );
}

// --- sign out ---------------------------------------------------------------

/** Ends the account session and reopens sign-in with the provider's account picker. */
export async function signOutAccount(): Promise<void> {
  const origin = requirePrimaryOrigin();
  const { credentials, headers } = accountRequestInit();
  const response = await fetch(`${origin}${ACCOUNT_SIGN_OUT_PATH}`, {
    method: "POST",
    credentials,
    ...(headers ? { headers } : {}),
  }).catch(() => null);
  if (isDesktop()) {
    // The desktop identity is the token we hold; dropping it signs this app out
    // even if the server is unreachable.
    clearDesktopAccountToken();
  } else if (!response?.ok) {
    throw new Error("Couldn't sign out. Check your connection and try again.");
  }
  reloadAt(`${ACCOUNT_SIGN_IN_ROUTE}?selectAccount=1`);
}
