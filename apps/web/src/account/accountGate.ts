import { ACCOUNT_SIGN_IN_ROUTE, type AccountSessionState } from "@t3tools/contracts/account";

/**
 * The one place that decides whether the primary environment's accounts send
 * a route to the sign-in screen. Root `beforeLoad` applies it before any
 * child route's pairing redirect runs, so with accounts on, nobody lands on
 * `/pair`; with accounts off (or an old server) nothing changes.
 */
export type AccountGateDecision =
  | { readonly _tag: "allow" }
  | { readonly _tag: "sign-in"; readonly returnTo?: string }
  | { readonly _tag: "leave-sign-in" };

/** Routes that never need a Signalbox account. `/connect` authorizes the CLI with T3 Connect. */
const ACCOUNT_EXEMPT_PATHS = new Set(["/connect"]);

export function decideAccountGate(input: {
  readonly pathname: string;
  /** Router path plus search, used to come back after sign-in. */
  readonly href: string;
  /** `null` when the state is unknown (request failed); the pairing gate still applies. */
  readonly session: AccountSessionState | null;
}): AccountGateDecision {
  const needsAccount = input.session?.enabled === true && input.session.account === null;

  // The page stays reachable while accounts are on, even signed in: desktop
  // sign-in finishes here in a system browser that may hold its own session.
  if (input.pathname === ACCOUNT_SIGN_IN_ROUTE) {
    return input.session?.enabled === true ? { _tag: "allow" } : { _tag: "leave-sign-in" };
  }
  if (!needsAccount || ACCOUNT_EXEMPT_PATHS.has(input.pathname)) return { _tag: "allow" };

  // `/pair` links carry a one-time token the bootstrap already spent; never
  // come back to one.
  const returnTo = input.pathname === "/pair" ? undefined : sanitizeReturnTo(input.href);
  return returnTo && returnTo !== "/" ? { _tag: "sign-in", returnTo } : { _tag: "sign-in" };
}

/**
 * A same-origin app path, or undefined. `//host` and `/\host` are
 * protocol-relative to browsers, and returning to `/sign-in` would loop.
 */
export function sanitizeReturnTo(value: string | undefined): string | undefined {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return undefined;
  }
  const pathname = value.split(/[?#]/u, 1)[0];
  return pathname === ACCOUNT_SIGN_IN_ROUTE ? undefined : value;
}
