import type { WorkOSOrganization } from "@signalbox/account/WorkOSClient";
import { SignalboxContextId } from "@t3tools/contracts/signalboxContexts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { normalRoleSlugs, RoleSlugs } from "./organizationRoles.ts";

/**
 * What still has to reach each organization about this person's membership in
 * it. One row per organization the person was ever seen in, holding the
 * latest accepted state: roles while a member, a tombstone (null roles) once
 * they left. A row is pending until delivery acknowledges its revision.
 *
 * Revisions are accepted refresh sequences (`organizationRefresh`), and the
 * outbox remembers the highest one it applied, so an older snapshot never
 * lands and a repeated one only proves it matches. After a snapshot the
 * active rows are exactly its organizations, which is what makes a repeat
 * checkable without storing the snapshot.
 *
 * Only snapshots seed rows. Legacy `organizations` rows are never read here:
 * they predate personal-organization filtering, so copying them could fan out
 * an organization the person must never be shown in.
 */

const PAGE_SIZE = 100;

/** `UserStore`'s `0027` migration. The runner runs it once, so no `IF NOT EXISTS`. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organization_membership_outbox (
    organization_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    role_slugs TEXT,
    pending INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX organization_membership_outbox_pending
    ON organization_membership_outbox (organization_id) WHERE pending = 1`;
  yield* sql`CREATE TABLE organization_membership_outbox_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    sequence INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO organization_membership_outbox_state (id, sequence) VALUES (1, 0)`;
});

/** A snapshot the outbox refuses whole, before writing anything. */
export class OrganizationMembershipSnapshotError extends Schema.TaggedError<OrganizationMembershipSnapshotError>()(
  "OrganizationMembershipSnapshotError",
  {
    reason: Schema.Literals([
      // Not a positive safe integer, so no revision could hold it.
      "invalid-sequence",
      // Repeating an organization makes the accepted membership list ambiguous.
      "duplicate-organization",
      "invalid-organization",
      // The sequence was applied before, with different memberships.
      "conflicting-replay",
    ]),
  },
) {
  override get message(): string {
    return `Organization membership snapshot refused (${this.reason}).`;
  }
}

/** One organization's latest undelivered membership state. */
export interface PendingMembership {
  readonly organizationId: SignalboxContextId;
  readonly revision: number;
  /** Null when the person left: deliver a removal. */
  readonly roleSlugs: ReadonlyArray<string> | null;
}

export interface PendingPage {
  readonly memberships: ReadonlyArray<PendingMembership>;
  /** Pass back as `after` for the next page; null when this one was the last. */
  readonly next: SignalboxContextId | null;
}

const decodeRoleSlugs = Schema.decodeUnknownSync(RoleSlugs);
const decodeRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      organization_id: SignalboxContextId,
      revision: Schema.Number,
      role_slugs: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodeSequenceRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ sequence: Schema.Number })),
);
// Ids come back through `SignalboxContextId`, which trims, so a padded one would read as another.
const isOrganizationId = (id: string) => id.length > 0 && id.trim() === id;

const refuse = (reason: OrganizationMembershipSnapshotError["reason"]) =>
  Effect.fail(new OrganizationMembershipSnapshotError({ reason }));

// A newer sequence always wins; the guard only keeps a corrupt row from going backwards.
const upsert = Effect.fnUntraced(function* (
  sequence: number,
  organizationId: string,
  roleSlugs: string | null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO organization_membership_outbox
        (organization_id, revision, role_slugs, pending)
      VALUES (${organizationId}, ${sequence}, ${roleSlugs}, 1)
      ON CONFLICT (organization_id) DO UPDATE SET revision = excluded.revision,
        role_slugs = excluded.role_slugs, pending = 1
      WHERE organization_membership_outbox.revision < excluded.revision`;
});

/**
 * Applies the memberships accepted refresh `sequence` read. Run it inside
 * that refresh's transaction, after `isLatest` passed, beside the membership
 * writes. `"stale"` means a newer snapshot was already applied and nothing was
 * written; `"replayed"` means this one was, with the same memberships. A
 * refusal writes nothing, so a caller that catches it leaves no partial state.
 */
export const syncSnapshot = (sequence: number, organizations: ReadonlyArray<WorkOSOrganization>) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
      return yield* refuse("invalid-sequence");
    }
    const incoming = new Map<string, string>();
    for (const organization of organizations) {
      if (!isOrganizationId(organization.id)) return yield* refuse("invalid-organization");
      if (incoming.has(organization.id)) return yield* refuse("duplicate-organization");
      incoming.set(organization.id, normalRoleSlugs(organization));
    }

    const sql = yield* SqlClient.SqlClient;
    const [state] = decodeSequenceRows(
      yield* sql`SELECT sequence FROM organization_membership_outbox_state WHERE id = 1`,
    );
    const applied = state?.sequence ?? 0;
    if (sequence < applied) return "stale" as const;
    // A repeat may only confirm what it wrote. Every revision is at most
    // `applied`, so a newer sequence can't conflict with anything stored.
    const replay = sequence === applied;

    // Keyset pages: rows this loop rewrites sit at or before the cursor, so none is skipped.
    const unseen = new Set(incoming.keys());
    let after = "";
    while (true) {
      const rows = decodeRows(
        yield* sql`SELECT organization_id, revision, role_slugs FROM organization_membership_outbox
          WHERE organization_id > ${after} ORDER BY organization_id LIMIT ${PAGE_SIZE}`,
      );
      const writes = rows.flatMap((row) => {
        const roleSlugs = incoming.get(row.organization_id);
        unseen.delete(row.organization_id);
        // Unchanged roles keep their revision, still pending if delivery hasn't caught up.
        if (roleSlugs !== undefined && row.role_slugs === roleSlugs) return [];
        // Only rows the outbox already holds can leave; a tombstone stays as it is.
        if (roleSlugs === undefined && row.role_slugs === null) return [];
        return [{ id: row.organization_id, roleSlugs: roleSlugs ?? null }];
      });
      if (replay && writes.length > 0) return yield* refuse("conflicting-replay");
      yield* Effect.forEach(writes, (write) => upsert(sequence, write.id, write.roleSlugs), {
        discard: true,
      });
      const last = rows.at(-1);
      if (rows.length < PAGE_SIZE || last === undefined) break;
      after = last.organization_id;
    }
    if (replay) {
      if (unseen.size > 0) return yield* refuse("conflicting-replay");
      return "replayed" as const;
    }

    yield* Effect.forEach(
      [...incoming].filter(([id]) => unseen.has(id)),
      ([id, roleSlugs]) => upsert(sequence, id, roleSlugs),
      { discard: true },
    );
    yield* sql`UPDATE organization_membership_outbox_state SET sequence = ${sequence} WHERE id = 1`;
    return "applied" as const;
  }).pipe(
    Effect.withSpan("OrganizationMembershipOutbox.syncSnapshot", { attributes: { sequence } }),
  );

/** Up to `limit` (at most 100) pending memberships after `after`, by organization id. */
export const pending = (
  options: { readonly after?: string | undefined; readonly limit?: number | undefined } = {},
) =>
  Effect.gen(function* () {
    const limit =
      options.limit !== undefined && Number.isSafeInteger(options.limit)
        ? Math.min(Math.max(options.limit, 1), PAGE_SIZE)
        : PAGE_SIZE;
    const sql = yield* SqlClient.SqlClient;
    const rows = decodeRows(
      yield* sql`SELECT organization_id, revision, role_slugs FROM organization_membership_outbox
        WHERE pending = 1 AND organization_id > ${options.after ?? ""}
        ORDER BY organization_id LIMIT ${limit}`,
    );
    const memberships = rows.map((row): PendingMembership => ({
      organizationId: row.organization_id,
      revision: row.revision,
      roleSlugs: row.role_slugs === null ? null : decodeRoleSlugs(row.role_slugs),
    }));
    const last = rows.at(-1);
    return {
      memberships,
      next: rows.length === limit && last !== undefined ? last.organization_id : null,
    } satisfies PendingPage;
  }).pipe(Effect.withSpan("OrganizationMembershipOutbox.pending"));

/**
 * Marks `revision` delivered. Only clears the row while that revision is
 * still its latest, so a delivery finishing after a newer change leaves the
 * newer one pending. False means nothing matched.
 */
export const acknowledge = (organizationId: string, revision: number) =>
  Effect.gen(function* () {
    if (!Number.isSafeInteger(revision) || revision < 1) return false;
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql`UPDATE organization_membership_outbox SET pending = 0
      WHERE organization_id = ${organizationId} AND revision = ${revision} AND pending = 1
      RETURNING organization_id`;
    return rows.length > 0;
  }).pipe(
    Effect.withSpan("OrganizationMembershipOutbox.acknowledge", { attributes: { revision } }),
  );
