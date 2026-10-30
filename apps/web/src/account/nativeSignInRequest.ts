import { AccountAuthorizeParams } from "@t3tools/contracts/account";
import * as Schema from "effect/Schema";

const decodeRequest = Schema.decodeUnknownOption(AccountAuthorizeParams);

/** Native sign-in collects an email in the browser without losing the app's PKCE target. */
export function nativeSignInRequest(search: string, origin: string) {
  const decoded = decodeRequest({ ...Object.fromEntries(new URLSearchParams(search)), origin });
  return decoded._tag === "Some" && decoded.value.mode === "native" ? decoded.value : null;
}
