/** The CLI and Computer compare cached bytes by this digest, so both must compute it the same way. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Computer's answer when its change feed proves the CLI's cached bytes unchanged. */
export const UNCHANGED_DIGEST = "unchanged";
