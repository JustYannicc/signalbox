import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";

/**
 * Secrets a table keeps only as a hash (connection links, local keys, pool
 * links): the hash, and a short public id taken from it that names a row for
 * listing and revoking without being any use as the secret.
 */

/** SHA-256 of the secret, lowercase hex. */
export const hashSecret = (crypto: Crypto.Crypto, secret: string) =>
  crypto
    .digest("SHA-256", new TextEncoder().encode(secret))
    .pipe(Effect.map(Hex.encode), Effect.orDie);

const PUBLIC_ID_LENGTH = 16;
const PUBLIC_ID = new RegExp(`^[0-9a-f]{${PUBLIC_ID_LENGTH}}$`);

export const publicIdOf = (secretHash: string) => secretHash.slice(0, PUBLIC_ID_LENGTH);

export const isPublicId = (id: string) => PUBLIC_ID.test(id);

/**
 * The hashes a public id names, as `[from, to)`. Hashes are lowercase hex, so
 * `secret_hash >= from AND secret_hash < to` is a primary-key scan.
 */
export const hashRangeOf = (id: string) => [id, `${id}g`] as const;
