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
}): Promise<void> {
  const bridge = window.desktopBridge;
  if (!bridge) throw new AccountFlowError("failed");
  const verifier = readPendingNativeSignIn()?.verifier ?? createPkceVerifier();
  const returnTo = sanitizeReturnTo(input.returnTo);
  // Same window, same origin: survives the main process reloading us on return.
  sessionStorage.setItem(
    PENDING_KEY,
    JSON.stringify({ verifier, ...(returnTo ? { returnTo } : {}) }),
  );
  const url = buildAccountAuthorizeUrl({
    provider: "email",
    mode: "native",
    via: "web",
    screenHint: input.screenHint,
    origin: requirePrimaryOrigin(),
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

function readPendingNativeSignIn(): { verifier: string; returnTo?: string } | null {
  const raw = sessionStorage.getItem(PENDING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { verifier?: unknown; returnTo?: unknown };
    if (typeof parsed.verifier !== "string") return null;
    const returnTo =
      typeof parsed.returnTo === "string" ? sanitizeReturnTo(parsed.returnTo) : undefined;
    return { verifier: parsed.verifier, ...(returnTo ? { returnTo } : {}) };
  } catch {
    return null;
  }
}

function takePendingNativeSignIn() {
  const pending = readPendingNativeSignIn();
  sessionStorage.removeItem(PENDING_KEY);
  return pending;
}

/** Redeems the handoff with this window's verifier, stores the account bearer, reloads signed in. */
export async function completeNativeSignIn(handoff: string): Promise<void> {
  const pending = takePendingNativeSignIn();
  if (!pending) throw new AccountFlowError("expired");
  const origin = requirePrimaryOrigin();
  const failed = () => {
    throw new AccountFlowError("failed");
  };
  const { credential } = await redeemAccountHandoff(origin, {
    handoff,
    verifier: pending.verifier,
  }).catch((error: unknown) => {
    throw new AccountFlowError(error instanceof AccountHandoffError ? error.code : "failed");
  });
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
