/**
 * PKCE (RFC 7636, S256) for the desktop sign-in handoff. The verifier never
 * leaves this client until it redeems the handoff; the server only ever sees
 * its hash in the authorize request.
 */

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** 32 random bytes, base64url: 43 characters, the RFC's minimum length. */
export function createPkceVerifier(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** base64url(SHA-256(verifier)), the `challenge` the authorize route expects. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}
