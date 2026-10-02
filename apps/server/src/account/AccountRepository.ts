import { AccountProfile } from "@t3tools/contracts/account";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";

/**
 * Profiles of WorkOS accounts that signed in here, so `/api/account/session`
 * can show who an `account:<id>` session belongs to. Refreshed on every
 * sign-in. Not an access list: any WorkOS account may sign in.
 *
 * Fork table: it creates itself instead of taking a migration number, because
 * the migration runner only applies ids above the latest recorded one and a
 * fork number would later shadow upstream's (see AGENTS.md).
 */

export type AccountRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface AccountSignIn {
  readonly id: string;
  readonly email: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly avatarUrl?: string;
  /** ISO instant. */
  readonly signedInAt: string;
}

const ProfileRow = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  firstName: Schema.NullOr(Schema.String),
  lastName: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ProfileRow));

const toProfile = (row: typeof ProfileRow.Type): AccountProfile => ({
  id: row.id,
  email: row.email,
  ...(row.firstName !== null ? { firstName: row.firstName } : {}),
  ...(row.lastName !== null ? { lastName: row.lastName } : {}),
  ...(row.avatarUrl !== null ? { avatarUrl: row.avatarUrl } : {}),
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS signalbox_account_profiles (
      workos_user_id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      first_name TEXT,
      last_name TEXT,
      avatar_url TEXT,
      created_at TEXT NOT NULL,
      last_sign_in_at TEXT NOT NULL
    )
  `.pipe(
    Effect.mapError(
      (cause) => new PersistenceSqlError({ operation: "createSignalboxAccountProfiles", cause }),
    ),
  );

  const columns = sql.literal(`
    workos_user_id AS "id",
    email AS "email",
    first_name AS "firstName",
    last_name AS "lastName",
    avatar_url AS "avatarUrl"
  `);

  const firstProfile = (
    operation: string,
    statement: Effect.Effect<ReadonlyArray<unknown>, SqlError>,
  ) =>
    statement.pipe(
      Effect.mapError((cause) => new PersistenceSqlError({ operation, cause })),
      Effect.flatMap(decodeRows),
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? PersistenceDecodeError.fromSchemaError(operation, cause)
          : cause,
      ),
      Effect.map((rows) => (rows[0] ? toProfile(rows[0]) : undefined)),
    );

  /** Records `input`'s current profile and returns it. */
  const upsert = (input: AccountSignIn) =>
    firstProfile(
      "upsertSignalboxAccountProfile",
      sql`
        INSERT INTO signalbox_account_profiles (
          workos_user_id, email, first_name, last_name, avatar_url, created_at, last_sign_in_at
        )
        VALUES (
          ${input.id}, ${input.email}, ${input.firstName ?? null}, ${input.lastName ?? null},
          ${input.avatarUrl ?? null}, ${input.signedInAt}, ${input.signedInAt}
        )
        ON CONFLICT (workos_user_id) DO UPDATE SET
          email = excluded.email,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          avatar_url = excluded.avatar_url,
          last_sign_in_at = excluded.last_sign_in_at
        RETURNING ${columns}
      `,
    ).pipe(
      Effect.flatMap((profile) =>
        profile
          ? Effect.succeed(profile)
          : Effect.fail(
              new PersistenceSqlError({
                operation: "upsertSignalboxAccountProfile",
                detail: "no row returned",
              }),
            ),
      ),
    );

  const find = (id: string) =>
    firstProfile(
      "findSignalboxAccountProfile",
      sql`SELECT ${columns} FROM signalbox_account_profiles WHERE workos_user_id = ${id}`,
    );

  return { upsert, find };
});
