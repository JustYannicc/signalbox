import type { WorkOSOrganization } from "@signalbox/account/WorkOSClient";
import {
  PERSONAL_CONTEXT_ID,
  type SignalboxContext,
  SignalboxContextId,
  type SignalboxContextsSnapshot,
} from "@t3tools/contracts/signalboxContexts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { contextProjectIds, projectIdForContext } from "./contextProjects.ts";
import * as OrganizationMembershipOutbox from "./organizationMembershipOutbox.ts";
import * as OrganizationRefresh from "./organizationRefresh.ts";
import { encodeRoleSlugs, normalRoleSlugs, RoleSlugs } from "./organizationRoles.ts";
import * as UserDriveIndex from "./UserDriveIndex.ts";

/**
 * One user's contexts, in the user's own object: Personal plus the WorkOS
 * organizations they belong to, as their latest sign-in or membership change
 * reported. Leaving an organization hides its context, the sections
 * organizing it and its drives without deleting them, so rejoining brings
 * everything back. A context's projects are its drives (`contextProjects`).
 *
 * Each membership keeps the member's WorkOS role slugs for organization
 * authority. They stay out of `SignalboxContext`: clients have no use for them.
 *
 * Memberships are read from WorkOS outside this object, so writes are ordered
 * by refresh reservations (`organizationRefresh`): only the latest may land.
 * Every accepted one also feeds the membership outbox
 * (`organizationMembershipOutbox`) in the same transaction, so what
 * organizations are told never drifts from what this object holds.
 */

type ContextRecord = Omit<SignalboxContext, "projectIds">;

const withProjects = (
  context: ContextRecord,
  drives: ReadonlyArray<UserDriveIndex.IndexedDrive>,
): SignalboxContext => ({
  ...context,
  projectIds: contextProjectIds(context.id, drives),
});

/** Personal with only its own project, for callers with no drives to list. */
export const PERSONAL_CONTEXT: SignalboxContext = {
  id: PERSONAL_CONTEXT_ID,
  kind: "personal",
  name: "Personal",
  projectIds: [projectIdForContext(PERSONAL_CONTEXT_ID)],
};

/** An active organization membership, as its latest sync left it. */
export interface OrganizationMembership {
  readonly organizationId: SignalboxContextId;
  /**
   * WorkOS role slugs, sorted and verbatim. Nothing here interprets them;
   * an unknown slug means no more than plain membership.
   */
  readonly roleSlugs: ReadonlyArray<string>;
}

/** One organization's membership, or its absence, and the revision it was read at. */
export interface OrganizationMembershipRead {
  /**
   * The contexts revision. It only grows, and every membership change moves
   * it, role changes and leaving included, so a removal is versioned too.
   */
  readonly revision: number;
  readonly membership: OrganizationMembership | null;
}

export class UserContexts extends Context.Service<
  UserContexts,
  {
    /**
     * Replaces the organization contexts with memberships the caller already
     * trusts, as one reservation applied at once, so it retires older refreshes.
     */
    readonly syncOrganizations: (
      organizations: ReadonlyArray<WorkOSOrganization>,
    ) => Effect.Effect<
      void,
      | SqlError
      | OrganizationRefresh.OrganizationRefreshExhaustedError
      | OrganizationMembershipOutbox.OrganizationMembershipSnapshotError
    >;
    /** Reserves a refresh before reading WorkOS; it retires every earlier reservation. */
    readonly reserveOrganizationRefresh: Effect.Effect<
      number,
      SqlError | OrganizationRefresh.OrganizationRefreshExhaustedError
    >;
    /**
     * Applies what reservation `sequence` read, if it's still the latest.
     * False means a newer one exists and nothing was written. True includes
     * an unchanged snapshot, which still reaches the outbox. A refused
     * snapshot writes nothing.
     */
    readonly completeOrganizationRefresh: (
      sequence: number,
      organizations: ReadonlyArray<WorkOSOrganization>,
    ) => Effect.Effect<
      boolean,
      SqlError | OrganizationMembershipOutbox.OrganizationMembershipSnapshotError
    >;
    /** The user's active membership in `organizationId`, null when they are not a member. */
    readonly membership: (
      organizationId: SignalboxContextId,
    ) => Effect.Effect<OrganizationMembershipRead, SqlError>;
    /** The user's current contexts, Personal first. */
    readonly contexts: Effect.Effect<ReadonlyArray<SignalboxContext>, SqlError>;
    /** Just their ids: what every access check needs, without listing projects. */
    readonly contextIds: Effect.Effect<ReadonlyArray<SignalboxContextId>, SqlError>;
    /** Grows with every change to the contexts; persisted. */
    readonly revision: Effect.Effect<number, SqlError>;
    /** Fires after each change to the contexts. */
    readonly contextsChanged: Stream.Stream<void>;
    /** The contexts now, then again after every change. */
    readonly changes: Stream.Stream<SignalboxContextsSnapshot, SqlError>;
  }
>()("@signalbox/cloud/user/UserContexts") {}

/** Part of `UserStore`'s `0004` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    member INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE contexts_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO contexts_state (id, revision) VALUES (1, 0)`;
});

/** `UserStore`'s `0025` migration. Rows from before it hold no roles. */
export const addRoleSlugs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE organizations ADD COLUMN role_slugs TEXT NOT NULL DEFAULT '[]'`;
});

const OrganizationRow = Schema.Struct({
  id: SignalboxContextId,
  name: Schema.String,
  role_slugs: RoleSlugs,
});
const decodeOrganizationRows = Schema.decodeUnknownSync(Schema.Array(OrganizationRow));
const decodeMembershipRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ role_slugs: Schema.NullOr(RoleSlugs), revision: Schema.Number })),
);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const driveIndex = yield* UserDriveIndex.UserDriveIndex;
  // Sliding at one: a subscriber that falls behind needs only the latest state.
  const changed = yield* PubSub.sliding<void>(1);

  const organizations = sql`SELECT id, name, role_slugs FROM organizations WHERE member = 1
    ORDER BY name COLLATE NOCASE, id`.pipe(Effect.map(decodeOrganizationRows));

  const contextIds: UserContexts["Service"]["contextIds"] = Effect.map(organizations, (orgs) => [
    PERSONAL_CONTEXT_ID,
    ...orgs.map((org) => org.id),
  ]);

  // One statement, so the membership and its revision are read together.
  const membership: UserContexts["Service"]["membership"] = (organizationId) =>
    sql`SELECT organizations.role_slugs, contexts_state.revision FROM contexts_state
      LEFT JOIN organizations
        ON organizations.id = ${organizationId} AND organizations.member = 1
      WHERE contexts_state.id = 1`.pipe(
      Effect.map((rows): OrganizationMembershipRead => {
        const [row] = decodeMembershipRows(rows);
        const roleSlugs = row?.role_slugs ?? null;
        return {
          revision: row?.revision ?? 0,
          membership: roleSlugs === null ? null : { organizationId, roleSlugs },
        };
      }),
      Effect.withSpan("UserContexts.membership"),
    );

  const contexts: UserContexts["Service"]["contexts"] = Effect.map(
    Effect.all([organizations, driveIndex.drives]),
    ([orgs, drives]) => [
      withProjects(PERSONAL_CONTEXT, drives),
      ...orgs.map((org) =>
        withProjects({ id: org.id, kind: "organization", name: org.name }, drives),
      ),
    ],
  );

  // Drives are the contexts' projects, so their changes are the contexts' too.
  const revision: UserContexts["Service"]["revision"] = Effect.map(
    Effect.all([
      sql<{ readonly revision: number }>`SELECT revision FROM contexts_state WHERE id = 1`,
      driveIndex.revision,
    ]),
    ([[row], drives]) => (row?.revision ?? 0) + drives,
  );

  /** Writes `orgs` unless they're what's stored. Run inside the transaction that ordered it. */
  const replaceOrganizations = (orgs: ReadonlyArray<WorkOSOrganization>) =>
    Effect.gen(function* () {
      const current = yield* organizations;
      const unchanged =
        current.length === orgs.length &&
        orgs.every((org) =>
          current.some(
            (row) =>
              row.id === org.id &&
              row.name === org.name &&
              encodeRoleSlugs(row.role_slugs) === normalRoleSlugs(org),
          ),
        );
      // Most sign-ins change nothing; skip the writes and the pushes to every client.
      if (unchanged) return false;
      // A former member holds no roles; rejoining brings the current ones.
      yield* sql`UPDATE organizations SET member = 0, role_slugs = '[]'`;
      yield* Effect.forEach(
        orgs,
        (org) =>
          sql`INSERT INTO organizations (id, name, member, role_slugs)
            VALUES (${org.id}, ${org.name}, 1, ${normalRoleSlugs(org)})
            ON CONFLICT (id) DO UPDATE SET name = excluded.name, member = 1,
              role_slugs = excluded.role_slugs`,
        { discard: true },
      );
      yield* sql`UPDATE contexts_state SET revision = revision + 1 WHERE id = 1`;
      return true;
    });

  const publishIf = (changedContexts: boolean) =>
    changedContexts ? PubSub.publish(changed, undefined) : Effect.void;

  const reserve = OrganizationRefresh.reserve.pipe(Effect.provideService(SqlClient.SqlClient, sql));

  /**
   * Lands accepted reservation `sequence`. The outbox runs even when the
   * memberships are unchanged: it may never have seen them. Run inside the
   * transaction that ordered it, so a refused snapshot undoes both.
   */
  const acceptOrganizations = (sequence: number, orgs: ReadonlyArray<WorkOSOrganization>) =>
    Effect.gen(function* () {
      const changedContexts = yield* replaceOrganizations(orgs);
      yield* OrganizationMembershipOutbox.syncSnapshot(sequence, orgs).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      return changedContexts;
    });

  const syncOrganizations: UserContexts["Service"]["syncOrganizations"] = (orgs) =>
    sql
      .withTransaction(Effect.flatMap(reserve, (sequence) => acceptOrganizations(sequence, orgs)))
      .pipe(Effect.flatMap(publishIf), Effect.withSpan("UserContexts.syncOrganizations"));

  const reserveOrganizationRefresh: UserContexts["Service"]["reserveOrganizationRefresh"] =
    reserve.pipe(Effect.withSpan("UserContexts.reserveOrganizationRefresh"));

  // The check and the writes share one transaction, so no newer reservation lands between them.
  const completeOrganizationRefresh: UserContexts["Service"]["completeOrganizationRefresh"] = (
    sequence,
    orgs,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const latest = yield* OrganizationRefresh.isLatest(sequence).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          if (!latest) return null;
          return yield* acceptOrganizations(sequence, orgs);
        }),
      )
      .pipe(
        Effect.flatMap((result) =>
          result === null ? Effect.succeed(false) : Effect.as(publishIf(result), true),
        ),
        Effect.withSpan("UserContexts.completeOrganizationRefresh", { attributes: { sequence } }),
      );

  yield* driveIndex.changed.pipe(
    Stream.runForEach(() => PubSub.publish(changed, undefined)),
    Effect.forkScoped,
  );

  const contextsChanged = Stream.fromPubSub(changed);

  const changes: UserContexts["Service"]["changes"] = Stream.unwrap(
    // Subscribe before the first read, so no change slips between them.
    Effect.map(PubSub.subscribe(changed), (subscription) =>
      Stream.fromSubscription(subscription).pipe(
        Stream.prepend([undefined]),
        Stream.mapEffect(() => Effect.map(contexts, (current) => ({ contexts: current }))),
      ),
    ),
  );

  return UserContexts.of({
    syncOrganizations,
    reserveOrganizationRefresh,
    completeOrganizationRefresh,
    membership,
    contexts,
    contextIds,
    revision,
    contextsChanged,
    changes,
  });
});

export const layer = Layer.effect(UserContexts, make);

/** The drive index the contexts list as their projects, plus the contexts. */
export const layerWithDrives = layer.pipe(Layer.provideMerge(UserDriveIndex.layer));
