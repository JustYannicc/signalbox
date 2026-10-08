import type { SignalboxDriveMember, SignalboxDriveRole } from "@t3tools/contracts/signalboxDrives";
import {
  canManageDrive,
  grantableDriveRoles,
  SignalboxDriveRole as RoleSchema,
} from "@t3tools/contracts/signalboxDrives";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { parseDriveId } from "./driveAccess.ts";

/**
 * Who is in one drive, in its own object: the authority every access check
 * ends at. A My Drive's owner is named by its id and never stored; everyone
 * else is a member with a role. Nothing caches a grant, so removing someone
 * takes effect on their next request, wherever it comes from.
 *
 * Each member row doubles as an outbox entry for that person's index (their
 * Shared with me): a change bumps its revision and the object delivers it. A
 * removed member's row stays, with no role, so their revisions only grow.
 */

/** A person as a drive records them. */
export interface DrivePerson {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
}

/** What a member's index should hold for this drive; `role` null once they're out. */
export interface AccessDelivery {
  readonly userId: string;
  readonly role: SignalboxDriveRole | null;
  readonly revision: number;
  readonly sharedBy: string | null;
}

export type MembershipChange =
  | { readonly _tag: "ok"; readonly member: SignalboxDriveMember }
  | { readonly _tag: "refused"; readonly reason: string };

export class DriveMembers extends Context.Service<
  DriveMembers,
  {
    /** Names the drive and seats its first members. Idempotent: a set-up drive keeps its own. */
    readonly setup: (input: {
      readonly name: string;
      readonly members: ReadonlyArray<DrivePerson & { readonly role: SignalboxDriveRole }>;
    }) => Effect.Effect<void, SqlError>;
    /** The drive's name, or null before it's set up. A My Drive needs none. */
    readonly name: Effect.Effect<string | null, SqlError>;
    readonly role: (userId: string) => Effect.Effect<SignalboxDriveRole | null, SqlError>;
    readonly members: Effect.Effect<ReadonlyArray<SignalboxDriveMember>, SqlError>;
    /** Adds `person` or changes their role, if `by` manages the drive. */
    readonly share: (
      by: DrivePerson,
      person: DrivePerson,
      role: SignalboxDriveRole,
    ) => Effect.Effect<MembershipChange, SqlError>;
    /** Removes `userId`, if `by` manages the drive or is removing themselves. */
    readonly unshare: (
      by: DrivePerson,
      userId: string,
    ) => Effect.Effect<
      { readonly _tag: "ok" } | { readonly _tag: "refused"; readonly reason: string },
      SqlError
    >;
    readonly pendingAccess: Effect.Effect<ReadonlyArray<AccessDelivery>, SqlError>;
    readonly acknowledgeAccess: (userId: string, revision: number) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/drive/DriveMembers") {}

/** Part of `DriveStore`'s `0002` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE drive (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE members (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    role TEXT,
    shared_by TEXT,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0
  )`;
});

const MemberRow = Schema.Struct({
  user_id: Schema.String,
  email: Schema.String,
  name: Schema.NullOr(Schema.String),
  role: RoleSchema,
});
const decodeMemberRows = Schema.decodeUnknownSync(Schema.Array(MemberRow));
const PendingRow = Schema.Struct({
  user_id: Schema.String,
  role: Schema.NullOr(RoleSchema),
  revision: Schema.Number,
  shared_by: Schema.NullOr(Schema.String),
});
const decodeRoleRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ role: Schema.NullOr(RoleSchema) })),
);
const decodePendingRows = Schema.decodeUnknownSync(Schema.Array(PendingRow));

const toMember = (row: typeof MemberRow.Type): SignalboxDriveMember => ({
  userId: row.user_id,
  email: row.email,
  name: row.name,
  role: row.role,
});

const displayName = (person: DrivePerson) => person.name ?? person.email;

/** `driveId` is the object's own name, which says its kind and a My Drive's owner. */
export const layer = (driveId: string) =>
  Layer.effect(
    DriveMembers,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const parsed = parseDriveId(driveId);
      const kind = parsed?.kind ?? null;

      const memberRows = sql`SELECT user_id, email, name, role FROM members
        WHERE role IS NOT NULL ORDER BY updated_at, user_id`.pipe(Effect.map(decodeMemberRows));

      const role: DriveMembers["Service"]["role"] = (userId) =>
        parsed?.owner === userId
          ? Effect.succeed("owner")
          : sql`SELECT role FROM members WHERE user_id = ${userId}`.pipe(
              Effect.map((rows) => decodeRoleRows(rows)[0]?.role ?? null),
            );

      const managers = Effect.map(memberRows, (rows) =>
        rows.filter((row) => canManageDrive(row.role)).map((row) => row.user_id),
      );

      const write = (
        person: DrivePerson,
        role: SignalboxDriveRole | null,
        sharedBy: string | null,
      ) =>
        Effect.flatMap(
          Clock.currentTimeMillis,
          (now) =>
            sql`INSERT INTO members (user_id, email, name, role, shared_by, updated_at, revision)
              VALUES (${person.userId}, ${person.email}, ${person.name}, ${role}, ${sharedBy},
                ${now}, 1)
              ON CONFLICT (user_id) DO UPDATE SET email = excluded.email, name = excluded.name,
                role = excluded.role, shared_by = excluded.shared_by,
                updated_at = excluded.updated_at, revision = members.revision + 1`,
        );

      const setup: DriveMembers["Service"]["setup"] = (input) =>
        Effect.gen(function* () {
          const existing = yield* sql`SELECT id FROM drive WHERE id = 1`;
          if (existing.length > 0) return;
          const now = yield* Clock.currentTimeMillis;
          yield* sql`INSERT INTO drive (id, name, created_at) VALUES (1, ${input.name}, ${now})`;
          for (const member of input.members) yield* write(member, member.role, null);
        }).pipe(sql.withTransaction);

      const name: DriveMembers["Service"]["name"] = sql<{
        readonly name: string;
      }>`SELECT name FROM drive WHERE id = 1`.pipe(Effect.map(([row]) => row?.name ?? null));

      const members: DriveMembers["Service"]["members"] = Effect.map(memberRows, (rows) =>
        rows.map(toMember),
      );

      const refused = (reason: string) => ({ _tag: "refused", reason }) as const;

      const share: DriveMembers["Service"]["share"] = (by, person, granted) =>
        Effect.gen(function* () {
          if (kind === null || !grantableDriveRoles(kind).includes(granted)) {
            return refused(
              kind === "my"
                ? "Share a folder from your My Drive instead of the whole drive."
                : "That role doesn't exist on this drive.",
            );
          }
          if (!canManageDrive(yield* role(by.userId))) {
            return refused("Only the drive's managers can share it.");
          }
          const current = yield* role(person.userId);
          if (current === "owner") return refused("That's the drive's owner.");
          if (canManageDrive(current) && !canManageDrive(granted)) {
            const others = (yield* managers).filter((id) => id !== person.userId);
            if (others.length === 0) return refused("A drive needs at least one manager.");
          }
          yield* write(person, granted, displayName(by));
          return {
            _tag: "ok",
            member: {
              userId: person.userId,
              email: person.email,
              name: person.name,
              role: granted,
            },
          } as const;
        }).pipe(sql.withTransaction);

      const unshare: DriveMembers["Service"]["unshare"] = (by, userId) =>
        Effect.gen(function* () {
          const leaving = by.userId === userId;
          if (!leaving && !canManageDrive(yield* role(by.userId))) {
            return refused("Only the drive's managers can remove people.");
          }
          const current = yield* role(userId);
          if (current === "owner") return refused("The owner can't be removed.");
          if (current === null) return { _tag: "ok" } as const;
          if (canManageDrive(current) && parsed?.kind === "shared") {
            const others = (yield* managers).filter((id) => id !== userId);
            if (others.length === 0) return refused("A drive needs at least one manager.");
          }
          const now = yield* Clock.currentTimeMillis;
          // Kept until the removal reaches their index; `role` null is what denies them.
          yield* sql`UPDATE members SET role = NULL, updated_at = ${now},
            revision = revision + 1 WHERE user_id = ${userId}`;
          return { _tag: "ok" } as const;
        }).pipe(sql.withTransaction);

      const pendingAccess: DriveMembers["Service"]["pendingAccess"] = sql`SELECT user_id, role,
          revision, shared_by FROM members WHERE revision > delivered ORDER BY updated_at`.pipe(
        Effect.map((rows) =>
          decodePendingRows(rows).map((row) => ({
            userId: row.user_id,
            role: row.role,
            revision: row.revision,
            sharedBy: row.shared_by,
          })),
        ),
      );

      const acknowledgeAccess: DriveMembers["Service"]["acknowledgeAccess"] = (userId, revision) =>
        Effect.asVoid(
          sql`UPDATE members SET delivered = ${revision}
            WHERE user_id = ${userId} AND delivered < ${revision}`,
        );

      return DriveMembers.of({
        setup,
        name,
        role,
        members,
        share,
        unshare,
        pendingAccess,
        acknowledgeAccess,
      });
    }),
  );
