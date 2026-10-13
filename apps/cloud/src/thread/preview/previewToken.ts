import type { ThreadId } from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { equalInConstantTime, leaseMac } from "../runner/leaseMac.ts";

/**
 * Preview credentials, derived from the machine's lease token like model
 * tokens (`runner/leaseMac.ts`), so the thread stores nothing and a new
 * machine generation voids every one at once:
 *
 *   sbp1.<base64url(claims)>.<base64url(HMAC-SHA256(lease token, claims))>
 *
 * A `ticket` rides in the link a client opens and lasts minutes; the preview
 * origin trades it for a `session`, kept in an HttpOnly cookie on that origin.
 * The Worker reads the thread id from the claims to know which thread to ask;
 * only the thread can check the MAC.
 */

const PREFIX = "sbp1";

const PreviewClaims = Schema.Struct({
  k: Schema.Literals(["ticket", "session"]),
  /** Thread id. */
  t: Schema.String,
  /** User id: re-checked against the thread's members on every request. */
  u: Schema.String,
  p: Schema.Number,
  /** Expiry, epoch ms. */
  exp: Schema.Number,
});
export type PreviewClaims = typeof PreviewClaims.Type;

const claimsJson = Schema.fromJsonString(PreviewClaims);
const encodeClaims = Schema.encodeSync(claimsJson);
const decodeClaims = Schema.decodeUnknownOption(claimsJson);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const mac = (leaseToken: string, payload: string) => leaseMac(leaseToken, `preview\n${payload}`);

export async function previewToken(leaseToken: string, claims: PreviewClaims) {
  const payload = Base64Url.encode(encoder.encode(encodeClaims(claims)));
  return `${PREFIX}.${payload}.${await mac(leaseToken, payload)}`;
}

const split = (token: string) => {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  const [, payload, signature] = parts as [string, string, string];
  const bytes = Base64Url.decode(payload);
  if (!Result.isSuccess(bytes)) return null;
  const claims = decodeClaims(decoder.decode(bytes.success));
  return claims._tag === "Some" ? { payload, signature, claims: claims.value } : null;
};

/** The thread a preview token names, or null when it is not one. Says nothing about validity. */
export function threadOfPreviewToken(token: string): ThreadId | null {
  return (split(token)?.claims.t ?? null) as ThreadId | null;
}

/** `token`'s claims when the lease token signed them and they are unexpired; null otherwise. */
export async function verifyPreviewToken(
  token: string,
  leaseToken: string,
  now: number,
): Promise<PreviewClaims | null> {
  const parts = split(token);
  if (parts === null || parts.claims.exp <= now) return null;
  const expected = await mac(leaseToken, parts.payload);
  return equalInConstantTime(parts.signature, expected) ? parts.claims : null;
}
