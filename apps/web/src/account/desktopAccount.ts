import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import {
  AccountHandoffError,
  buildAccountAuthorizeUrl,
  redeemAccountHandoff,
} from "@t3tools/client-runtime/account";

import { runtime } from "../lib/runtime";
import { AccountFlowError, reloadAt, requirePrimaryOrigin } from "./accountPlatform";
import { sanitizeReturnTo } from "./accountGate";
import { createPkceVerifier, pkceChallenge } from "./pkce";

/**
 * Desktop sign-in. It happens in the system browser, where providers allow
 * OAuth and password managers, saved sessions and passkeys work. The server's
 * `/sign-in` page there forwards the result to a deep link, which the main
 * process maps to `/sign-in?handoff=…` in this renderer. The renderer talks to its server with a
 * desktop-managed bearer that is never an account, so the handoff's one-time
 * credential becomes a separate account bearer, kept here and shown only to
 * the account routes.
 *
 * The same flow adds another environment that offers accounts, such as
 * Signalbox Cloud: the attempt then names that environment's origin, and its
 * credential pairs the environment like a pairing code would.
 */

const TOKEN_KEY = "signalbox.account.desktopToken";
const PENDING_KEY = "signalbox.account.pendingNative";
const NATIVE_RETURN_PATH = "/account-return";

export function readDesktopAccountToken(): string | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown };
    if (typeof stored.token !== "string" || typeof stored.expiresAt !== "number") return null;
    return stored.expiresAt > Date.now() ? stored.token : null;
  } catch {
    return null;
  }
}

export function clearDesktopAccountToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Opens WorkOS's hosted page in the system browser, on the sign-up or sign-in
 * tab. A browser that already has a WorkOS session comes straight back.
 * "Open browser again" reuses the pending verifier, so an earlier tab can
 * still finish.
 */
export async function startNativeSignIn(input: {
  readonly screenHint: "sign-in" | "sign-up";
  readonly selectAccount?: boolean;
  readonly returnTo?: string;
  /** Sign in to this environment and add it, instead of the primary one. */
  readonly environmentOrigin?: string;
}): Promise<void> {
  const bridge = window.desktopBridge;
  if (!bridge) throw new AccountFlowError("failed");
  const pending = readPendingNativeSignIn();
  // A retry for the same target reuses the verifier, so an earlier tab can still finish.
  const verifier =
    pending && pending.environmentOrigin === input.environmentOrigin
      ? pending.verifier
      : createPkceVerifier();
  const returnTo = sanitizeReturnTo(input.returnTo);
  // Same window, same origin: survives the main process reloading us on return.
  sessionStorage.setItem(
    PENDING_KEY,
    JSON.stringify({
      verifier,
      ...(returnTo ? { returnTo } : {}),
      ...(input.environmentOrigin ? { environmentOrigin: input.environmentOrigin } : {}),
    }),
  );
  const url = buildAccountAuthorizeUrl({
    provider: "email",
    mode: "native",
    via: "web",
    screenHint: input.screenHint,
    origin: input.environmentOrigin ?? requirePrimaryOrigin(),
    returnUrl: `${window.location.protocol}//${window.location.host}${NATIVE_RETURN_PATH}`,
    challenge: await pkceChallenge(verifier),
    ...(input.selectAccount ? { selectAccount: "1" as const } : {}),
  });
  if (!(await bridge.openExternal(url))) throw new AccountFlowError("failed");
}

/** "Cancel": forget the attempt so a late deep link can't finish it. */
export function cancelNativeSignIn() {
  sessionStorage.removeItem(PENDING_KEY);
}

interface PendingNativeSignIn {
  readonly verifier: string;
  readonly returnTo?: string;
  readonly environmentOrigin?: string;
}

function readPendingNativeSignIn(): PendingNativeSignIn | null {
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      verifier?: unknown;
      returnTo?: unknown;
      environmentOrigin?: unknown;
    };
    if (typeof parsed.verifier !== "string") return null;
    const returnTo =
      typeof parsed.returnTo === "string" ? sanitizeReturnTo(parsed.returnTo) : undefined;
    const environmentOrigin =
      typeof parsed.environmentOrigin === "string" ? parsed.environmentOrigin : undefined;
    return {
      verifier: parsed.verifier,
      ...(returnTo ? { returnTo } : {}),
      ...(environmentOrigin ? { environmentOrigin } : {}),
    };
  } catch {
    return null;
  }
}

/** The environment this window is waiting to add by signing in to it, if any. */
export function readPendingEnvironmentSignIn(): string | null {
  return readPendingNativeSignIn()?.environmentOrigin ?? null;
}

function takePendingNativeSignIn() {
  const pending = readPendingNativeSignIn();
  sessionStorage.removeItem(PENDING_KEY);
  return pending;
}

const redeem = (origin: string, handoff: string, verifier: string) =>
  redeemAccountHandoff(origin, { handoff, verifier }).catch((error: unknown) => {
    throw new AccountFlowError(error instanceof AccountHandoffError ? error.code : "failed");
  });

/**
 * Adding an environment: redeems the handoff against it and returns the
 * one-time credential that pairs it, like a pairing code would.
 */
export async function completeEnvironmentSignIn(
  handoff: string,
): Promise<{ readonly origin: string; readonly credential: string }> {
  const pending = takePendingNativeSignIn();
  if (!pending?.environmentOrigin) throw new AccountFlowError("expired");
  const origin = pending.environmentOrigin;
  const { credential } = await redeem(origin, handoff, pending.verifier);
  return { origin, credential };
}

/** Redeems the handoff with this window's verifier, stores the account bearer, reloads signed in. */
export async function completeNativeSignIn(handoff: string): Promise<void> {
  const pending = takePendingNativeSignIn();
  if (!pending) throw new AccountFlowError("expired");
  const origin = requirePrimaryOrigin();
  const failed = () => {
    throw new AccountFlowError("failed");
  };
  const { credential } = await redeem(origin, handoff, pending.verifier);
  const access = await runtime
    .runPromise(
      bootstrapRemoteBearerSession({
        httpBaseUrl: origin,
        credential,
        clientMetadata: { label: "Signalbox Desktop", deviceType: "desktop" },
      }),
    )
    .catch(failed);
  localStorage.setItem(
    TOKEN_KEY,
    JSON.stringify({
      token: access.access_token,
      expiresAt: Date.now() + access.expires_in * 1000,
    }),
  );
  reloadAt(pending.returnTo ?? "/");
}
