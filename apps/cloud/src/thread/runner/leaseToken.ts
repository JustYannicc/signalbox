import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Result from "effect/Result";

/**
 * Credentials derived from a machine's lease token, so the thread stores
 * nothing new and a newer lease voids every older one:
 *
 *   <prefix>.<base64url(thread id)>.<base64url(HMAC-SHA256(lease token, message))>
 *
 * The thread id says which thread to ask; that thread recomputes the token
 * from its current lease. Model tokens (`modelToken.ts`) and drive tokens
 * (`drive/driveToken.ts`) differ only in prefix and signed message.
 */

const encoder = new TextEncoder();

export const signLeaseToken = (
  prefix: string,
  leaseToken: string,
  threadId: ThreadId,
  message: string,
) =>
  Effect.promise(async () => {
    const subtle = globalThis.crypto.subtle;
    const key = await subtle.importKey(
      "raw",
      encoder.encode(leaseToken),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await subtle.sign("HMAC", key, encoder.encode(message));
    return `${prefix}.${Base64Url.encode(threadId)}.${Base64Url.encode(new Uint8Array(mac))}`;
  });

/** The thread a `prefix` token names, or null when it is not one. Says nothing about validity. */
export function threadOfLeaseToken(prefix: string, token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== prefix || parts[1] === undefined) return null;
  const decoded = Base64Url.decode(parts[1]);
  return Result.isSuccess(decoded) ? new TextDecoder().decode(decoded.success) : null;
}

/** Whether `token` equals `expected`, compared in constant time. */
export const isLeaseToken = (token: string, expected: Effect.Effect<string>) =>
  Effect.map(expected, (want) => {
    if (token.length !== want.length) return false;
    let difference = 0;
    for (let index = 0; index < want.length; index++) {
      difference |= token.charCodeAt(index) ^ want.charCodeAt(index);
    }
    return difference === 0;
  });
