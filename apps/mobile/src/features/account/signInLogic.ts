import {
  ACCOUNT_NATIVE_RETURN_SCHEMES,
  AccountProvider,
  type AccountSignInError,
} from "@t3tools/contracts/account";
import * as Base64Url from "effect/encoding/Base64Url";

/**
 * Pure pieces of mobile account sign-in: which server, where WorkOS sends the
 * user back, PKCE, and what to say when it fails. The hook in
 * useAccountSignIn.ts owns the side effects.
 */

/** Path of the deep link the server hands off to after native sign-in. */
export const ACCOUNT_RETURN_PATH = "account-return";

function isLocalHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (bare === "localhost" || bare.includes(":")) return true;
  const octets = bare.split(".");
  return (
    octets.length === 4 && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

/**
 * Turns what someone typed ("box.example.com", "192.168.1.5:3773/",
 * "https://x.ts.net/anything") into the origin the account routes hang off. Bare
 * IPs and localhost default to http, everything else to https, matching how
 * pairing fills in a schemeless host. Returns null when it isn't a usable
 * http(s) address.
 */
export function normalizeServerUrl(input: string | undefined | null): string | null {
  const trimmed = input?.trim() ?? "";
  if (!trimmed) return null;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
    const probe = new URL(hasScheme ? trimmed : `http://${trimmed}`);
    const url = hasScheme
      ? probe
      : new URL(`${isLocalHost(probe.hostname) ? "http" : "https"}://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password) return null;
    // The server only accepts a bare origin (it builds its own redirect URIs
    // from it), so a pasted path or a pairing link's hash is dropped.
    return url.origin;
  } catch {
    return null;
  }
}

/** Host shown under the headline, e.g. "box.example.com". */
export function serverDisplayHost(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

/**
 * The deep link WorkOS returns through, built from the app's own scheme
 * (`signalbox`, `signalbox-dev`, `signalbox-preview`). Deliberately not
 * `Linking.createURL`: in a dev client that embeds the Metro host
 * (`signalbox-dev://192.168.1.5:8081/...`). Null when the build's scheme is
 * one the server refuses to hand off to.
 */
export function accountReturnUrl(
  scheme: string | ReadonlyArray<string> | undefined,
): string | null {
  const schemes = typeof scheme === "string" ? [scheme] : (scheme ?? []);
  const allowed = schemes.find((candidate) =>
    (ACCOUNT_NATIVE_RETURN_SCHEMES as ReadonlyArray<string>).includes(`${candidate}:`),
  );
  return allowed ? `${allowed}://${ACCOUNT_RETURN_PATH}` : null;
}

export interface PkceCrypto {
  readonly randomBytes: (byteCount: number) => Uint8Array;
  readonly sha256: (data: Uint8Array) => Promise<Uint8Array>;
}

/** RFC 7636 S256: base64url(SHA-256(ASCII(verifier))), unpadded. */
export async function pkceChallenge(verifier: string, crypto: PkceCrypto): Promise<string> {
  return Base64Url.encode(await crypto.sha256(new TextEncoder().encode(verifier)));
}

/** 32 random bytes give a 43-character verifier, the RFC minimum length. */
export async function createPkcePair(crypto: PkceCrypto) {
  const verifier = Base64Url.encode(crypto.randomBytes(32));
  return { verifier, challenge: await pkceChallenge(verifier, crypto) };
}

/** Social providers in contract order; `email` gets its own field. */
export function socialProviders(
  providers: ReadonlyArray<AccountProvider>,
): ReadonlyArray<Exclude<AccountProvider, "email">> {
  return AccountProvider.literals.filter(
    (provider): provider is Exclude<AccountProvider, "email"> =>
      provider !== "email" && providers.includes(provider),
  );
}

/** What to show for a callback or handoff error. `cancelled` stays quiet. */
export function signInFailureCopy(error: AccountSignInError): string | null {
  switch (error) {
    case "cancelled":
      return null;
    case "expired":
      return "Sign-in took too long. Try again.";
    case "failed":
      return "Sign-in didn't go through. Try again.";
  }
}
