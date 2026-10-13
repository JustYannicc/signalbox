import * as Base64Url from "effect/encoding/Base64Url";

/**
 * Credentials derived from a machine's lease token (model tokens, preview
 * links and cookies): HMAC-SHA256 keyed by the lease token, so the thread
 * stores nothing and a new generation voids every one at once.
 */

const encoder = new TextEncoder();

/** The last lease token's key: it only changes with the machine generation. */
let cached: { readonly leaseToken: string; readonly key: Promise<CryptoKey> } | null = null;

const keyFor = (leaseToken: string) => {
  if (cached?.leaseToken !== leaseToken) {
    const key = globalThis.crypto.subtle.importKey(
      "raw",
      encoder.encode(leaseToken),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    cached = { leaseToken, key };
  }
  return cached.key;
};

/** base64url(HMAC-SHA256(lease token, message)). */
export async function leaseMac(leaseToken: string, message: string): Promise<string> {
  const mac = await globalThis.crypto.subtle.sign(
    "HMAC",
    await keyFor(leaseToken),
    encoder.encode(message),
  );
  return Base64Url.encode(new Uint8Array(mac));
}

export function equalInConstantTime(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
