import type { AccountSignInError } from "@t3tools/contracts/account";

import {
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
} from "../environments/primary";

/** Plumbing shared by the browser and desktop halves of account sign-in. */

export const isDesktop = () => typeof window !== "undefined" && window.desktopBridge !== undefined;

export class AccountFlowError extends Error {
  constructor(readonly code: AccountSignInError) {
    super(`Sign-in failed (${code}).`);
  }
}

/** The primary environment server's origin, or null when there is none. */
export function primaryOrigin(): string | null {
  try {
    if (!readPrimaryEnvironmentTarget()) return null;
    return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin;
  } catch {
    return null;
  }
}

export function requirePrimaryOrigin(): string {
  const origin = primaryOrigin();
  if (!origin) throw new AccountFlowError("failed");
  return origin;
}

/**
 * Load the app fresh at `path`. Sign-in and sign-out end here so every cache,
 * connection, and the account state itself start over. Desktop routes live in
 * the hash.
 */
export function reloadAt(path: string) {
  window.history.replaceState(null, "", isDesktop() ? `#${path}` : path);
  window.location.reload();
}
