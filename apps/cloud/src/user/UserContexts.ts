import type { WorkOSOrganization } from "@signalbox/account/WorkOSClient";
import {
  PERSONAL_CONTEXT_ID,
  type SignalboxContext,
  SignalboxContextId,
  type SignalboxContextsSnapshot,
  SignalboxSectionError,
  SignalboxSectionId,
} from "@t3tools/contracts/signalboxContexts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/**
 * One user's contexts and the sections they organize them with, in the user's
 * own object. Contexts are Personal plus the WorkOS organizations the user
 * belonged to at their latest sign-in. Leaving an organization hides its
 * context and sections without deleting them, so rejoining brings the tree
 * back.
 *
 * Sections only organize: nothing here touches where anything is stored or
 * who can reach it.
 */

export const PERSONAL_CONTEXT: SignalboxContext = {
  id: PERSONAL_CONTEXT_ID,
  kind: "personal",
  name: "Personal",
};

type SectionId = SignalboxSectionId;
type ParentId = SectionId | null;

export class UserContexts extends Context.Service<
  UserContexts,
  {
    /** Replaces the organization contexts with the user's current memberships. */
    readonly syncOrganizations: (
      organizations: ReadonlyArray<WorkOSOrganization>,
    ) => Effect.Effect<void, SqlError>;
    /** The user's current contexts, Personal first. Cheaper than a snapshot: no sections. */
    readonly contexts: Effect.Effect<ReadonlyArray<SignalboxContext>, SqlError>;
    /** Fires after each change to the contexts themselves, never for a section. */
    readonly contextsChanged: Stream.Stream<void>;
    readonly snapshot: Effect.Effect<SignalboxContextsSnapshot, SqlError>;
    /** The snapshot now, then again after every change. */
    readonly changes: Stream.Stream<SignalboxContextsSnapshot, SqlError>;
    readonly createSection: (input: {
      readonly sectionId: SectionId;
      readonly contextId: SignalboxContextId;
      readonly parentId: ParentId;
      readonly name: string;
    }) => Effect.Effect<void, SignalboxSectionError | SqlError>;
    readonly renameSection: (input: {
      readonly sectionId: SectionId;
      readonly name: string;
    }) => Effect.Effect<void, SignalboxSectionError | SqlError>;
    readonly moveSection: (input: {
      readonly sectionId: SectionId;
      readonly parentId: ParentId;
      readonly index: number;
    }) => Effect.Effect<void, SignalboxSectionError | SqlError>;
    readonly deleteSection: (input: {
      readonly sectionId: SectionId;
    }) => Effect.Effect<void, SignalboxSectionError | SqlError>;
  }
>()("@signalbox/cloud/user/UserContexts") {}

/** `UserStore`'s `0002` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    member INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE sections (
    id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  )`;
  yield* sql`CREATE INDEX sections_by_parent ON sections (context_id, parent_id, position)`;
});

const OrganizationRow = Schema.Struct({ id: SignalboxContextId, name: Schema.String });
const SectionRow = Schema.Struct({
  id: SignalboxSectionId,
  context_id: SignalboxContextId,
  parent_id: Schema.NullOr(SignalboxSectionId),
  name: Schema.String,
});
const decodeOrganizationRows = Schema.decodeUnknownSync(Schema.Array(OrganizationRow));
const decodeSectionRows = Schema.decodeUnknownSync(Schema.Array(SectionRow));
const decodeIdRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ id: SignalboxSectionId })),
);

const sectionError = (reason: SignalboxSectionError["reason"]) =>
  new SignalboxSectionError({ reason });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Sliding at one: a client that falls behind needs only the latest state.
  const changed = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changed, undefined);
  const organizationsChanged = yield* PubSub.sliding<void>(1);

  const organizations = sql`SELECT id, name FROM organizations WHERE member = 1
    ORDER BY name COLLATE NOCASE, id`.pipe(Effect.map(decodeOrganizationRows));

  const isCurrentContext = (contextId: SignalboxContextId) =>
    contextId === PERSONAL_CONTEXT_ID
      ? Effect.succeed(true)
      : sql`SELECT 1 FROM organizations WHERE id = ${contextId} AND member = 1`.pipe(
          Effect.map((rows) => rows.length > 0),
        );

  const sectionRow = (sectionId: SectionId) =>
    sql`SELECT id, context_id, parent_id, name FROM sections WHERE id = ${sectionId}`.pipe(
      Effect.map((rows) => decodeSectionRows(rows)[0]),
    );

  /** A section in one of the user's current contexts. */
  const findSection = Effect.fn("UserContexts.findSection")(function* (sectionId: SectionId) {
    const row = yield* sectionRow(sectionId);
    return row && (yield* isCurrentContext(row.context_id)) ? row : undefined;
  });

  const requireSection = (sectionId: SectionId) =>
    findSection(sectionId).pipe(
      Effect.filterOrFail(
        (row) => row !== undefined,
        () => sectionError("unknown-section"),
      ),
    );

  const siblingIds = (contextId: SignalboxContextId, parentId: ParentId) =>
    sql`SELECT id FROM sections WHERE context_id = ${contextId}
      AND parent_id IS ${parentId} ORDER BY position, created_at`.pipe(
      Effect.map((rows) => decodeIdRows(rows).map((row) => row.id)),
    );

  const renumber = (ids: ReadonlyArray<SectionId>, parentId: ParentId) =>
    Effect.forEach(
      ids,
      (id, position) =>
        sql`UPDATE sections SET parent_id = ${parentId}, position = ${position} WHERE id = ${id}`,
      { discard: true },
    );

  /**
   * A parent the section can live under: absent, or in its context and not
   * below itself. Callers have already checked the context is current.
   */
  const validParent = Effect.fn("UserContexts.validParent")(function* (
    contextId: SignalboxContextId,
    parentId: ParentId,
    moving?: SectionId,
  ) {
    let cursor = parentId;
    while (cursor !== null) {
      if (cursor === moving) return false;
      const row = yield* sectionRow(cursor);
      if (!row || row.context_id !== contextId) return false;
      cursor = row.parent_id;
    }
    return true;
  });

  const contexts: UserContexts["Service"]["contexts"] = Effect.map(organizations, (orgs) => [
    PERSONAL_CONTEXT,
    ...orgs.map((org) => ({ id: org.id, kind: "organization" as const, name: org.name })),
  ]);

  const snapshot: UserContexts["Service"]["snapshot"] = Effect.gen(function* () {
    const current = yield* contexts;
    // Sections of contexts the user left stay stored but out of sight.
    const sections = decodeSectionRows(
      yield* sql`SELECT s.id, s.context_id, s.parent_id, s.name FROM sections s
        WHERE s.context_id = ${PERSONAL_CONTEXT_ID}
          OR s.context_id IN (SELECT id FROM organizations WHERE member = 1)
        ORDER BY s.position, s.created_at`,
    );
    return {
      contexts: current,
      sections: sections.map((row) => ({
        id: row.id,
        contextId: row.context_id,
        parentId: row.parent_id,
        name: row.name,
      })),
    };
  }).pipe(Effect.withSpan("UserContexts.snapshot"));

  const changes: UserContexts["Service"]["changes"] = Stream.unwrap(
    // Subscribe before the first read, so no change slips between them.
    Effect.map(PubSub.subscribe(changed), (subscription) =>
      Stream.fromSubscription(subscription).pipe(
        Stream.prepend([undefined]),
        Stream.mapEffect(() => snapshot),
        // A change that changed nothing (a retried create, a same-name rename) isn't news.
        Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)),
      ),
    ),
  );

  /** Runs a change in one transaction, then tells every subscriber. */
  const change = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(effect).pipe(Effect.tap(() => notify));

  const syncOrganizations: UserContexts["Service"]["syncOrganizations"] = (orgs) =>
    Effect.gen(function* () {
      const current = yield* organizations;
      const unchanged =
        current.length === orgs.length &&
        orgs.every((org) => current.some((row) => row.id === org.id && row.name === org.name));
      // Most sign-ins change nothing; skip the writes and the pushes to every client.
      if (unchanged) return;
      yield* change(
        Effect.gen(function* () {
          yield* sql`UPDATE organizations SET member = 0`;
          yield* Effect.forEach(
            orgs,
            (org) =>
              sql`INSERT INTO organizations (id, name, member) VALUES (${org.id}, ${org.name}, 1)
                ON CONFLICT (id) DO UPDATE SET name = excluded.name, member = 1`,
            { discard: true },
          );
        }),
      );
      yield* PubSub.publish(organizationsChanged, undefined);
    }).pipe(Effect.withSpan("UserContexts.syncOrganizations"));

  const createSection: UserContexts["Service"]["createSection"] = (input) =>
    change(
      Effect.gen(function* () {
        if (!(yield* isCurrentContext(input.contextId))) {
          return yield* sectionError("unknown-context");
        }
        const [existing] = decodeSectionRows(
          yield* sql`SELECT id, context_id, parent_id, name FROM sections
            WHERE id = ${input.sectionId}`,
        );
        if (existing) {
          // A retry of a create that already landed.
          if (existing.context_id === input.contextId) return;
          return yield* sectionError("id-taken");
        }
        if (!(yield* validParent(input.contextId, input.parentId))) {
          return yield* sectionError("invalid-parent");
        }
        const [last] = yield* sql<{
          readonly position: number | null;
        }>`SELECT MAX(position) AS position
          FROM sections WHERE context_id = ${input.contextId} AND parent_id IS ${input.parentId}`;
        const next = (last?.position ?? -1) + 1;
        yield* sql`INSERT INTO sections (id, context_id, parent_id, name, position, created_at)
          VALUES (${input.sectionId}, ${input.contextId}, ${input.parentId}, ${input.name},
            ${next}, ${yield* Clock.currentTimeMillis})`;
      }),
    ).pipe(Effect.withSpan("UserContexts.createSection"));

  const renameSection: UserContexts["Service"]["renameSection"] = (input) =>
    change(
      Effect.gen(function* () {
        yield* requireSection(input.sectionId);
        yield* sql`UPDATE sections SET name = ${input.name} WHERE id = ${input.sectionId}`;
      }),
    ).pipe(Effect.withSpan("UserContexts.renameSection"));

  const moveSection: UserContexts["Service"]["moveSection"] = (input) =>
    change(
      Effect.gen(function* () {
        const section = yield* requireSection(input.sectionId);
        if (!(yield* validParent(section.context_id, input.parentId, section.id))) {
          return yield* sectionError("invalid-parent");
        }
        const siblings = (yield* siblingIds(section.context_id, input.parentId)).filter(
          (id) => id !== section.id,
        );
        siblings.splice(Math.min(input.index, siblings.length), 0, section.id);
        yield* renumber(siblings, input.parentId);
      }),
    ).pipe(Effect.withSpan("UserContexts.moveSection"));

  const deleteSection: UserContexts["Service"]["deleteSection"] = (input) =>
    change(
      Effect.gen(function* () {
        const section = yield* requireSection(input.sectionId);
        const children = yield* siblingIds(section.context_id, section.id);
        const siblings = (yield* siblingIds(section.context_id, section.parent_id)).flatMap((id) =>
          id === section.id ? children : [id],
        );
        yield* sql`DELETE FROM sections WHERE id = ${section.id}`;
        yield* renumber(siblings, section.parent_id);
      }),
    ).pipe(Effect.withSpan("UserContexts.deleteSection"));

  return UserContexts.of({
    syncOrganizations,
    contexts,
    contextsChanged: Stream.fromPubSub(organizationsChanged),
    snapshot,
    changes,
    createSection,
    renameSection,
    moveSection,
    deleteSection,
  });
});

export const layer = Layer.effect(UserContexts, make);
