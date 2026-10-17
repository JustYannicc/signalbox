import { PortSchema, type ThreadId } from "@t3tools/contracts";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { equalInConstantTime, leaseMac } from "../runner/leaseMac.ts";

/**
 * A thread key signs preview credentials independently of its machine lease.
 * Tickets cross from the signed-in app to the isolated preview origin, which
 * trades them for an HttpOnly session. Membership is checked on every use.
 */

const PREFIX = "sbp1";

const PreviewClaims = Schema.Struct({
  k: Schema.Literals(["ticket", "session"]),
  /** Thread id. */
  t: Schema.String,
  /** User id: re-checked against the thread's members on every request. */
  u: Schema.String,
  p: PortSchema,
  /** Expiry, epoch ms. */
  exp: Schema.Number,
});
export type PreviewClaims = typeof PreviewClaims.Type;

const claimsJson = Schema.fromJsonString(PreviewClaims);
const encodeClaims = Schema.encodeSync(claimsJson);
const decodeClaims = Schema.decodeUnknownOption(claimsJson);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const mac = (key: string, payload: string) => leaseMac(key, `preview\n${payload}`);

export async function previewToken(key: string, claims: PreviewClaims) {
  const payload = Base64Url.encode(encoder.encode(encodeClaims(claims)));
  return `${PREFIX}.${payload}.${await mac(key, payload)}`;
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

/** Claims are authoritative only after signature and expiry verification. */
export async function verifyPreviewToken(
  token: string,
  key: string,
  now: number,
): Promise<PreviewClaims | null> {
  const parts = split(token);
  if (parts === null || parts.claims.exp <= now) return null;
  const expected = await mac(key, parts.payload);
  return equalInConstantTime(parts.signature, expected) ? parts.claims : null;
}

/** Routing hints only. An expired or forged token never authorizes access. */
export const previewTokenTarget = (token: string) => {
  const claims = split(token)?.claims;
  return claims === undefined ? null : { threadId: claims.t, port: claims.p };
};
