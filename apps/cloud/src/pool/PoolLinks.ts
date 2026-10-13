import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * A pool's links: tokens a self-hosted server holds to reach this pool after
 * moving its own pool here (`poolLink.ts`). A link acts for the user who made
 * it, so it works exactly as long as that user keeps their grant.
 *
 * A new link takes one move of accounts within `MOVE_WINDOW_MS`. A link whose
 * move never landed stops working when the window ends, so a failed or
 * abandoned move leaves nothing behind that reaches the pool.
 *
 * Only a hash of each secret is kept.
 */

export const MOVE_WINDOW_MS = 10 * 60_000;

export interface ResolvedLink {
  readonly userId: string;
  /** Still within its move window: it may move accounts in. */
  readonly moveOpen: boolean;
}

export class PoolLinks extends Context.Service<
  PoolLinks,
  {
    /** A new link acting for `userId`. Returns its secret, which is never stored. */
    readonly open: (userId: string) => Effect.Effect<string, SqlError>;
    /** Who the link with this secret acts for, or null when there is none or it lapsed. */
    readonly resolve: (secret: string) => Effect.Effect<ResolvedLink | null, SqlError>;
    /** Marks the link's move as landed, so it keeps working past its move window. */
    readonly claim: (secret: string) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/pool/PoolLinks") {}

/** Part of the pool object's migrations. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE links (
    secret_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    move_until INTEGER NOT NULL,
    claimed INTEGER NOT NULL DEFAULT 0
  )`;
});

/** A random 32-byte key, hex encoded. */
export const randomKey = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(yield* Effect.orDie(crypto.randomBytes(32)));
});

export const layer = Layer.effect(
  PoolLinks,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const hash = (secret: string) =>
      crypto
        .digest("SHA-256", new TextEncoder().encode(secret))
        .pipe(Effect.map(Hex.encode), Effect.orDie);

    const open: PoolLinks["Service"]["open"] = (userId) =>
      Effect.gen(function* () {
        const secret = yield* randomKey.pipe(Effect.provideService(Crypto.Crypto, crypto));
        const now = yield* Clock.currentTimeMillis;
        // Lapsed links that never moved anything go, so the table stays small.
        yield* sql`DELETE FROM links WHERE claimed = 0 AND move_until <= ${now}`;
        yield* sql`INSERT INTO links (secret_hash, user_id, created_at, move_until)
          VALUES (${yield* hash(secret)}, ${userId}, ${now}, ${now + MOVE_WINDOW_MS})`;
        return secret;
      });

    const resolve: PoolLinks["Service"]["resolve"] = (secret) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          readonly user_id: string;
          readonly move_until: number;
          readonly claimed: number;
        }>`SELECT user_id, move_until, claimed FROM links
          WHERE secret_hash = ${yield* hash(secret)}`;
        if (row === undefined) return null;
        const moveOpen = (yield* Clock.currentTimeMillis) < row.move_until;
        return row.claimed === 1 || moveOpen ? { userId: row.user_id, moveOpen } : null;
      });

    const claim: PoolLinks["Service"]["claim"] = (secret) =>
      Effect.flatMap(hash(secret), (secretHash) =>
        Effect.asVoid(sql`UPDATE links SET claimed = 1 WHERE secret_hash = ${secretHash}`),
      );

    return PoolLinks.of({ open, resolve, claim });
  }),
);
