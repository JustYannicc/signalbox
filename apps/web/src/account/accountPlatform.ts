import { AccountSignInError } from "@t3tools/contracts/account";
import * as Schema from "effect/Schema";

import {
  readPrimaryEnvironmentTarget,
  resolvePrimaryEnvironmentHttpUrl,
} from "../environments/primary";

/** Plumbing shared by the browser and desktop halves of account sign-in. */

export const isDesktop = () => typeof window !== "undefined" && window.desktopBridge !== undefined;

export class AccountFlowError extends Schema.TaggedError<AccountFlowError>()("AccountFlowError", {
  code: AccountSignInError,
}) {
  override get message(): string {
    return `Sign-in failed (${this.code}).`;
  }
}

export const accountFlowError = (code: AccountSignInError) => new AccountFlowError({ code });
export const isAccountFlowError = Schema.is(AccountFlowError);

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
  if (!origin) throw accountFlowError("failed");
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
