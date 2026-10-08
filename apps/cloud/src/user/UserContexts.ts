import type { WorkOSOrganization } from "@signalbox/account/WorkOSClient";
import { DriveRemote } from "@signalbox/runner-protocol/DriveProtocol";
import { IsoDateTime, ProjectId } from "@t3tools/contracts";
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

import { projectIdForContext } from "./contextProjects.ts";

/**
 * One user's contexts, in the user's own object: Personal plus the WorkOS
 * organizations they belonged to at their latest sign-in. Leaving an
 * organization hides its context, and the sections organizing it, without
 * deleting them, so rejoining brings everything back.
 *
 * Each context has its own project, plus the remote repositories the user
 * imported into it (#135). Each of those is a drive of its own whose home is
 * the remote.
 */

type ContextRecord = Omit<SignalboxContext, "projectIds">;

/** A project backed by a remote repository, which the user imported into a context. */
export const RemoteProject = Schema.Struct({
  projectId: ProjectId,
  contextId: SignalboxContextId,
  title: Schema.String,
  /** Where clients address the project; its threads' working trees sit under it. */
  workspaceRoot: Schema.String,
  remote: DriveRemote,
  createdAt: IsoDateTime,
});
export type RemoteProject = typeof RemoteProject.Type;

const withProjects = (
  context: ContextRecord,
  remoteProjects: ReadonlyArray<RemoteProject> = [],
): SignalboxContext => ({
  ...context,
  projectIds: [
    projectIdForContext(context.id),
    ...remoteProjects
      .filter((project) => project.contextId === context.id)
      .map((project) => project.projectId),
  ],
});

export const PERSONAL_CONTEXT: SignalboxContext = withProjects({
  id: PERSONAL_CONTEXT_ID,
  kind: "personal",
  name: "Personal",
});

export class UserContexts extends Context.Service<
  UserContexts,
  {
    /** Replaces the organization contexts with the user's current memberships. */
    readonly syncOrganizations: (
      organizations: ReadonlyArray<WorkOSOrganization>,
    ) => Effect.Effect<void, SqlError>;
    /** The user's current contexts, Personal first. */
    readonly contexts: Effect.Effect<ReadonlyArray<SignalboxContext>, SqlError>;
    /** Every remote-backed project the user imported, oldest first, in any context. */
    readonly remoteProjects: Effect.Effect<ReadonlyArray<RemoteProject>, SqlError>;
    /** Adds an imported project to its context. Fails with `false` when its workspace root is taken. */
    readonly addRemoteProject: (project: RemoteProject) => Effect.Effect<boolean, SqlError>;
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

/** Part of `UserStore`'s `0005` migration. */
export const createRemoteProjectTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE remote_projects (
    project_id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL,
    title TEXT NOT NULL,
    workspace_root TEXT NOT NULL UNIQUE,
    remote TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
});

const OrganizationRow = Schema.Struct({ id: SignalboxContextId, name: Schema.String });
const decodeOrganizationRows = Schema.decodeUnknownSync(Schema.Array(OrganizationRow));
const RemoteProjectRow = Schema.Struct({
  project_id: ProjectId,
  context_id: SignalboxContextId,
  title: Schema.String,
  workspace_root: Schema.String,
  remote: Schema.fromJsonString(DriveRemote),
  created_at: IsoDateTime,
});
const decodeRemoteProjectRows = Schema.decodeUnknownSync(Schema.Array(RemoteProjectRow));
const encodeRemote = Schema.encodeSync(Schema.fromJsonString(DriveRemote));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Sliding at one: a subscriber that falls behind needs only the latest state.
  const changed = yield* PubSub.sliding<void>(1);

  const organizations = sql`SELECT id, name FROM organizations WHERE member = 1
    ORDER BY name COLLATE NOCASE, id`.pipe(Effect.map(decodeOrganizationRows));

  const remoteProjects: UserContexts["Service"]["remoteProjects"] = sql`SELECT project_id,
      context_id, title, workspace_root, remote, created_at
    FROM remote_projects ORDER BY created_at, project_id`.pipe(
    Effect.map((rows) =>
      decodeRemoteProjectRows(rows).map((row) => ({
        projectId: row.project_id,
        contextId: row.context_id,
        title: row.title,
        workspaceRoot: row.workspace_root,
        remote: row.remote,
        createdAt: row.created_at,
      })),
    ),
  );

  const contexts: UserContexts["Service"]["contexts"] = Effect.gen(function* () {
    const orgs = yield* organizations;
    const imported = yield* remoteProjects;
    return [
      withProjects(PERSONAL_CONTEXT, imported),
      ...orgs.map((org) =>
        withProjects({ id: org.id, kind: "organization", name: org.name }, imported),
      ),
    ];
  });

  const addRemoteProject: UserContexts["Service"]["addRemoteProject"] = (project) =>
    Effect.gen(function* () {
      const added = yield* sql.withTransaction(
        Effect.gen(function* () {
          const taken = yield* sql`SELECT project_id FROM remote_projects
            WHERE workspace_root = ${project.workspaceRoot} OR project_id = ${project.projectId}`;
          if (taken.length > 0) return false;
          yield* sql`INSERT INTO remote_projects
            (project_id, context_id, title, workspace_root, remote, created_at)
            VALUES (${project.projectId}, ${project.contextId}, ${project.title},
              ${project.workspaceRoot}, ${encodeRemote(project.remote)}, ${project.createdAt})`;
          yield* sql`UPDATE contexts_state SET revision = revision + 1 WHERE id = 1`;
          return true;
        }),
      );
      if (added) yield* PubSub.publish(changed, undefined);
      return added;
    }).pipe(Effect.withSpan("UserContexts.addRemoteProject"));

  const revision: UserContexts["Service"]["revision"] = sql<{
    readonly revision: number;
  }>`SELECT revision FROM contexts_state WHERE id = 1`.pipe(
    Effect.map(([row]) => row?.revision ?? 0),
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
    remoteProjects,
    addRemoteProject,
    revision,
    contextsChanged,
    changes,
  });
});

export const layer = Layer.effect(UserContexts, make);
