import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The user this object belongs to, from `UserStore`'s profile, for services
 * `UserStore` runs migrations of (importing it would be a cycle). It never
 * changes once known, so it's read until it is.
 */
export const makeProfileId = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const known = yield* Ref.make<string | null>(null);
  return Effect.gen(function* () {
    const cached = yield* Ref.get(known);
    if (cached !== null) return cached;
    const rows = yield* sql<{ readonly id: string }>`SELECT id FROM profile LIMIT 1`;
    const id = rows[0]?.id ?? null;
    if (id !== null) yield* Ref.set(known, id);
    return id;
  });
});
