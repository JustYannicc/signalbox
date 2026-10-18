import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Orders one person's organization refreshes. WorkOS is read outside the
 * user object, so two refreshes can finish in either order. Each reserves a
 * sequence before it reads, and only the latest reservation may write: a
 * newer one retires every older one even if it never completes, so a slow
 * read can't restore memberships a newer read already replaced, or was about
 * to. The sequence is durable, so a restarted object still refuses them.
 */

/** `UserStore`'s `0026` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_refresh (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sequence INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO organization_refresh (id, sequence) VALUES (1, 0)`;
});

/** No sequence is left to reserve. Refusing keeps every older one retired. */
export class OrganizationRefreshExhaustedError extends Schema.TaggedError<OrganizationRefreshExhaustedError>()(
  "OrganizationRefreshExhaustedError",
  {},
) {
  override get message(): string {
    return "Organization refreshes ran out of sequence numbers.";
  }
}

const decodeSequenceRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ sequence: Schema.Number })),
);

/** Reserves the next refresh, retiring every earlier one. One statement, so it's atomic alone. */
export const reserve = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [row] = decodeSequenceRows(
    yield* sql`UPDATE organization_refresh SET sequence = sequence + 1
      WHERE id = 1 AND sequence < ${Number.MAX_SAFE_INTEGER} RETURNING sequence`,
  );
  if (row === undefined) return yield* new OrganizationRefreshExhaustedError();
  return row.sequence;
});

/** Whether `sequence` is still the latest reservation. Read it in the transaction that writes. */
export const isLatest = (sequence: number) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(sequence) || sequence < 1) return false;
    const sql = yield* SqlClient.SqlClient;
    const [row] = decodeSequenceRows(
      yield* sql`SELECT sequence FROM organization_refresh WHERE id = 1`,
    );
    return row?.sequence === sequence;
  });
