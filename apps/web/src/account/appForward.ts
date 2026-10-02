import { parseAccountReturn } from "@t3tools/client-runtime/account";
import { ACCOUNT_NATIVE_RETURN_SCHEMES, type AccountSignInError } from "@t3tools/contracts/account";

export type AppForward =
  | { readonly _tag: "handoff"; readonly url: string }
  | { readonly _tag: "error"; readonly url: string; readonly error: AccountSignInError };

const NATIVE_SCHEMES: ReadonlySet<string> = new Set(ACCOUNT_NATIVE_RETURN_SCHEMES);

/**
 * Desktop sign-in finishes on this web page in the system browser:
 * `/sign-in?returnUrl=<app deep link>&handoff=…` (or `&error=…`). Returns the
 * deep link carrying the result to the app, or null when this is an ordinary
 * web visit or `returnUrl` isn't a Signalbox app link.
 */
export function appForwardUrl(searchStr: string): AppForward | null {
  const params = new URLSearchParams(searchStr);
  const returnUrl = params.get("returnUrl");
  if (!returnUrl) return null;
  let target: URL;
  try {
    target = new URL(returnUrl);
  } catch {
    return null;
  }
  if (!NATIVE_SCHEMES.has(target.protocol) || target.username || target.password) return null;

  const result = parseAccountReturn(new URL(`?${params.toString()}`, "http://signalbox.invalid"));
  if (!result) return null;
  if (result._tag === "handoff") {
    target.searchParams.set("handoff", result.handoff);
    return { _tag: "handoff", url: target.toString() };
  }
  target.searchParams.set("error", result.error);
  return { _tag: "error", url: target.toString(), error: result.error };
}
