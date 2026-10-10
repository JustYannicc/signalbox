import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import type { PoolActor } from "./PoolEngine.ts";

/**
 * A pool's links: tokens a self-hosted server holds to reach this pool after
 * moving its own pool here (`poolLink.ts`). A link acts for the user who made
 * it, so it works exactly as long as that user keeps their grant. Right after
 * it is made, it may also move accounts in.
 *
 * Only a hash of each secret is kept.
 */

/** How long a new link takes accounts: one move, retried a few times at most. */
export const MOVE_WINDOW_MS = 10 * 60_000;

export interface ResolvedLink {
  readonly actor: PoolActor;
  readonly moveOpen: boolean;
}

export class PoolLinks extends Context.Service<
  PoolLinks,
  {
    /** A new link acting for `actor`. Returns its secret, which is never stored. */
    readonly open: (actor: PoolActor) => Effect.Effect<string, SqlError>;
    /** Who the link with this secret acts for, or null when there is none. */
    readonly resolve: (secret: string) => Effect.Effect<ResolvedLink | null, SqlError>;
  }
>()("@signalbox/cloud/pool/PoolLinks") {}

/** Part of the pool object's migrations. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE links (
    secret_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    move_until INTEGER NOT NULL
  )`;
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

    const open: PoolLinks["Service"]["open"] = (actor) =>
      Effect.gen(function* () {
        const secret = Hex.encode(yield* Effect.orDie(crypto.randomBytes(32)));
        const now = yield* Clock.currentTimeMillis;
        yield* sql`INSERT INTO links (secret_hash, user_id, created_at, move_until)
          VALUES (${yield* hash(secret)}, ${actor.userId}, ${now}, ${now + MOVE_WINDOW_MS})`;
        return secret;
      });

    const resolve: PoolLinks["Service"]["resolve"] = (secret) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          readonly user_id: string;
          readonly move_until: number;
        }>`SELECT user_id, move_until FROM links WHERE secret_hash = ${yield* hash(secret)}`;
        if (row === undefined) return null;
        return {
          actor: { userId: row.user_id },
          moveOpen: (yield* Clock.currentTimeMillis) < row.move_until,
        };
      });

    return PoolLinks.of({ open, resolve });
  }),
);
