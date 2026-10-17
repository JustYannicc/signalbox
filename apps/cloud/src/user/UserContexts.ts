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
import * as UserDriveIndex from "./UserDriveIndex.ts";

/**
 * One user's contexts, in the user's own object: Personal plus the WorkOS
 * organizations they belong to, as their latest sign-in or membership change
 * reported. Leaving an organization hides its context, the sections
 * organizing it and its drives without deleting them, so rejoining brings
 * everything back. A context's projects are its drives (`contextProjects`).
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

export class UserContexts extends Context.Service<
  UserContexts,
  {
    /** Replaces the organization contexts with the user's current memberships. */
    readonly syncOrganizations: (
      organizations: ReadonlyArray<WorkOSOrganization>,
    ) => Effect.Effect<void, SqlError>;
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

const OrganizationRow = Schema.Struct({ id: SignalboxContextId, name: Schema.String });
const decodeOrganizationRows = Schema.decodeUnknownSync(Schema.Array(OrganizationRow));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const driveIndex = yield* UserDriveIndex.UserDriveIndex;
  // Sliding at one: a subscriber that falls behind needs only the latest state.
  const changed = yield* PubSub.sliding<void>(1);

  const organizations = sql`SELECT id, name FROM organizations WHERE member = 1
    ORDER BY name COLLATE NOCASE, id`.pipe(Effect.map(decodeOrganizationRows));

  const contextIds: UserContexts["Service"]["contextIds"] = Effect.map(organizations, (orgs) => [
    PERSONAL_CONTEXT_ID,
    ...orgs.map((org) => org.id),
  ]);

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

  const syncOrganizations: UserContexts["Service"]["syncOrganizations"] = (orgs) =>
    Effect.gen(function* () {
      const current = yield* organizations;
      const unchanged =
        current.length === orgs.length &&
        orgs.every((org) => current.some((row) => row.id === org.id && row.name === org.name));
      // Most sign-ins change nothing; skip the writes and the pushes to every client.
      if (unchanged) return;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE organizations SET member = 0`;
          yield* Effect.forEach(
            orgs,
            (org) =>
              sql`INSERT INTO organizations (id, name, member) VALUES (${org.id}, ${org.name}, 1)
                ON CONFLICT (id) DO UPDATE SET name = excluded.name, member = 1`,
            { discard: true },
          );
          yield* sql`UPDATE contexts_state SET revision = revision + 1 WHERE id = 1`;
        }),
      );
      yield* PubSub.publish(changed, undefined);
    }).pipe(Effect.withSpan("UserContexts.syncOrganizations"));

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
