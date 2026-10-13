import {
  ACCOUNT_NATIVE_RETURN_SCHEMES,
  ACCOUNT_VERIFY_EMAIL_PATH,
  AccountVerifyEmailFailure,
  AccountVerifyEmailResult,
} from "@t3tools/contracts/account";
import * as Schema from "effect/Schema";

/**
 * Email verification during sign-in. Some providers (GitHub) make WorkOS
 * email a code before finishing; the callback lands on
 * `/sign-in?verify=<id>&email=<address>` and this posts the code.
 */

export interface VerifyRequest {
  readonly verify: string;
  readonly email?: string;
}

export type VerifyOutcome =
  | { readonly _tag: "next"; readonly next: string }
  | { readonly _tag: "error"; readonly error: AccountVerifyEmailFailure["error"] };

const isResult = Schema.is(AccountVerifyEmailResult);
const isFailure = Schema.is(AccountVerifyEmailFailure);
const APP_SCHEMES: ReadonlySet<string> = new Set(ACCOUNT_NATIVE_RETURN_SCHEMES);

export function parseVerifyRequest(searchStr: string): VerifyRequest | null {
  const params = new URLSearchParams(searchStr);
  const verify = params.get("verify");
  if (!verify) return null;
  const email = params.get("email");
  return email ? { verify, email } : { verify };
}

/** People paste "123 456" or "123-456"; the code is what's left. */
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/gu, "");
}

/**
 * The server's `next` is a same-origin path, a URL on this origin, or a
 * Signalbox app deep link. Anything else (another site, `javascript:`) is
 * refused rather than followed.
 */
export function safeNextUrl(next: string, origin: string): string | null {
  if (next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")) return next;
  try {
    const url = new URL(next);
    if (url.origin === origin || APP_SCHEMES.has(url.protocol)) return url.toString();
  } catch {
    // Not a URL.
  }
  return null;
}

export function classifyVerifyResponse(ok: boolean, body: unknown, origin: string): VerifyOutcome {
  if (ok && isResult(body)) {
    const next = safeNextUrl(body.next, origin);
    return next ? { _tag: "next", next } : { _tag: "error", error: "failed" };
  }
  return { _tag: "error", error: !ok && isFailure(body) ? body.error : "failed" };
}

/** Posts the code. `credentials: "include"` so browser mode receives its session cookie. */
export async function submitVerifyEmailCode(
  origin: string,
  request: { readonly verify: string; readonly code: string },
): Promise<VerifyOutcome> {
  const response = await fetch(`${origin}${ACCOUNT_VERIFY_EMAIL_PATH}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  }).catch(() => null);
  if (!response) return { _tag: "error", error: "failed" };
  const body: unknown = await response.json().catch(() => null);
  return classifyVerifyResponse(response.ok, body, origin);
}
