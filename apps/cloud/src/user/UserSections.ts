import type { ProjectId } from "@t3tools/contracts";
import {
  type PoolLevel,
  type ProjectSectionPlacement,
  type Section,
  type SectionCreateInput,
  type SectionDeleteInput,
  SectionId,
  type SectionMoveInput,
  type SectionProjectMoveInput,
  SectionsRpcError,
  type SectionsRpcErrorCode,
  type SectionsPools,
  type SectionsSnapshot,
  type SectionUpdateInput,
} from "@t3tools/contracts/sections";
import { PERSONAL_CONTEXT_ID, type SignalboxContext } from "@t3tools/contracts/signalboxContexts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { type PoolTree, resolvePool } from "./poolChain.ts";
import * as ResourceBindings from "./ResourceBindings.ts";
import * as UserContexts from "./UserContexts.ts";

/**
 * The user's sections, serving the same `sections.*` contract as a self-hosted
 * server (`apps/server/src/sections`), from their own object. In the cloud
 * every section organizes one context: a top-level section names it (Personal
 * when it doesn't say), a
 * subsection shares its parent's, and neither sections nor projects move
 * between contexts. Sections never change where anything is stored or who
 * can reach it; they do decide what it runs on: a pool placed at a section
 * serves the projects below it (`poolChain.ts`), from their next turn.
 */

type Failure = SectionsRpcError | SqlError;

export class UserSections extends Context.Service<
  UserSections,
  {
    readonly snapshot: Effect.Effect<SectionsSnapshot, SqlError>;
    /** The snapshot now, then again after every change, contexts included. */
    readonly changes: Stream.Stream<SectionsSnapshot, SqlError>;
    readonly create: (input: SectionCreateInput) => Effect.Effect<SectionsSnapshot, Failure>;
    readonly update: (input: SectionUpdateInput) => Effect.Effect<SectionsSnapshot, Failure>;
    readonly move: (input: SectionMoveInput) => Effect.Effect<SectionsSnapshot, Failure>;
    readonly delete: (input: SectionDeleteInput) => Effect.Effect<SectionsSnapshot, Failure>;
    readonly moveProject: (
      input: SectionProjectMoveInput,
    ) => Effect.Effect<SectionsSnapshot, Failure>;
    /** Takes a deleted pool off every level, so they inherit from above again. */
    readonly forgetPool: (poolId: string) => Effect.Effect<void, SqlError>;
    /** What every current project, and the top level, runs on now. */
    readonly pools: Effect.Effect<SectionsPools, SqlError>;
    /** Every row as stored, contexts left included: what a preview takes along (`previewSetup/`). */
    readonly rows: Effect.Effect<SectionRows, SqlError>;
    /** Adds rows another of this user's clouds holds, never over ones here. */
    readonly adopt: (rows: SectionRows) => Effect.Effect<void, SqlError>;
  }
>()("@signalbox/cloud/user/UserSections") {}

/** Part of `UserStore`'s `0004` migration. */
export const createTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE sections (
    id TEXT PRIMARY KEY,
    context_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE project_placements (
    project_id TEXT PRIMARY KEY,
    section_id TEXT,
    position INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE sections_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO sections_state (id, revision) VALUES (1, 0)`;
});

export const SectionRow = Schema.Struct({
  id: SectionId,
  context_id: Schema.String,
  parent_id: Schema.NullOr(SectionId),
  name: Schema.String,
  position: Schema.Number,
});
export const PlacementRow = Schema.Struct({
  project_id: Schema.String,
  section_id: Schema.NullOr(SectionId),
  position: Schema.Number,
});
export const SectionRows = Schema.Struct({
  sections: Schema.Array(SectionRow),
  placements: Schema.Array(PlacementRow),
  // Optional: a cloud from before pools by hierarchy sends none.
  bindings: Schema.optionalKey(Schema.Array(ResourceBindings.BindingRow)),
});
export type SectionRows = typeof SectionRows.Type;
const decodeSectionRows = Schema.decodeUnknownSync(Schema.Array(SectionRow));
const decodePlacementRows = Schema.decodeUnknownSync(Schema.Array(PlacementRow));

const toSection = (row: typeof SectionRow.Type, poolId: string | undefined): Section => ({
  id: row.id,
  name: row.name,
  parentId: row.parent_id,
  position: row.position,
  contextId: row.context_id,
  ...(poolId === undefined ? {} : { defaultPoolId: poolId }),
});

const fail = (code: SectionsRpcErrorCode, detail: string) =>
  Effect.fail(new SectionsRpcError({ code, detail }));

/** Position order, ties broken by id like the clients' (`sectionsModel.ts`). */
const byPosition = <A extends { readonly position: number }>(
  rows: ReadonlyArray<A>,
  idOf: (row: A) => string,
) =>
  rows.toSorted(
    (left, right) => left.position - right.position || idOf(left).localeCompare(idOf(right)),
  );

/** `ids` with `id` moved before `beforeId`, or to the end; undefined when the anchor isn't there. */
const insertBefore = <A extends string>(ids: ReadonlyArray<A>, id: A, beforeId?: A) => {
  const without = ids.filter((candidate) => candidate !== id);
  const index = beforeId === undefined ? without.length : without.indexOf(beforeId);
  return index < 0 ? undefined : [...without.slice(0, index), id, ...without.slice(index)];
};

const sameOrder = <A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** Everything a change is decided from: the user's current contexts and what organizes them. */
interface State {
  readonly contexts: ReadonlyArray<SignalboxContext>;
  readonly sections: ReadonlyArray<typeof SectionRow.Type>;
  readonly placements: ReadonlyArray<typeof PlacementRow.Type>;
  readonly bindings: ReadonlyArray<ResourceBindings.PoolBinding>;
}

/**
 * The user's tree as pools see it: a project sits in its section, or at the
 * top level when it has none; a section sits in its parent, or at the top.
 */
const treeOf = (current: State): PoolTree => {
  const parentOf = new Map(current.sections.map((row) => [row.id, row.parent_id]));
  const sectionOf = new Map(current.placements.map((row) => [row.project_id, row.section_id]));
  const inSection = (sectionId: string | null | undefined): PoolLevel =>
    sectionId != null && parentOf.has(sectionId) ? { _tag: "section", sectionId } : { _tag: "top" };
  return {
    parentOf: (level) => {
      switch (level._tag) {
        case "top":
          return null;
        case "section":
          return inSection(parentOf.get(level.sectionId));
        case "project":
          return inSection(sectionOf.get(level.projectId));
      }
    },
    bindings: current.bindings,
  };
};

const poolsOf = (current: State): SectionsPools => {
  const tree = treeOf(current);
  return {
    top: resolvePool(tree, { _tag: "top" }),
    sections: current.sections.map((row) => ({
      sectionId: row.id,
      pool: resolvePool(tree, { _tag: "section", sectionId: row.id }),
    })),
    projects: current.contexts
      .flatMap((context) => context.projectIds)
      .map((projectId) => ({
        projectId,
        pool: resolvePool(tree, { _tag: "project", projectId }),
      })),
  };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const contexts = yield* UserContexts.UserContexts;
  const bindings = yield* ResourceBindings.ResourceBindings;
  // Own changes and context changes share one signal, so a subscriber that
  // subscribes before its first read misses neither.
  const changed = yield* PubSub.sliding<void>(1);
  yield* contexts.contextsChanged.pipe(
    Stream.runForEach(() => PubSub.publish(changed, undefined)),
    Effect.forkScoped,
  );

  /** Only what belongs to a current context: sections of contexts the user left stay out of sight. */
  const state: Effect.Effect<State, SqlError> = Effect.gen(function* () {
    const current = yield* contexts.contexts;
    const contextIds = new Set<string>(current.map((context) => context.id));
    const projectIds = new Set<string>(current.flatMap((context) => context.projectIds));
    const sections = decodeSectionRows(
      yield* sql`SELECT id, context_id, parent_id, name, position FROM sections`,
    ).filter((row) => contextIds.has(row.context_id));
    const sectionIds = new Set<string>(sections.map((row) => row.id));
    const placements = decodePlacementRows(
      yield* sql`SELECT project_id, section_id, position FROM project_placements`,
    ).filter(
      (row) =>
        projectIds.has(row.project_id) &&
        (row.section_id === null || sectionIds.has(row.section_id)),
    );
    return { contexts: current, sections, placements, bindings: yield* bindings.pools };
  });

  const revision = Effect.all([
    sql<{ readonly revision: number }>`SELECT revision FROM sections_state WHERE id = 1`,
    contexts.revision,
  ]).pipe(Effect.map(([[row], contextsRevision]) => (row?.revision ?? 0) + contextsRevision));

  const snapshot: UserSections["Service"]["snapshot"] = Effect.gen(function* () {
    const current = yield* state;
    const ownPool = new Map(
      current.bindings.flatMap((binding) =>
        binding.level._tag === "section"
          ? [[binding.level.sectionId, binding.poolId] as const]
          : [],
      ),
    );
    return {
      // Both parts only grow, so their sum orders snapshots across either kind of change.
      revision: yield* revision,
      sections: byPosition(current.sections, (row) => row.id).map((row) =>
        toSection(row, ownPool.get(row.id)),
      ),
      projectPlacements: current.placements.map((row): ProjectSectionPlacement => ({
        projectId: row.project_id as ProjectId,
        sectionId: row.section_id,
        position: row.position,
      })),
      pools: poolsOf(current),
    };
  });

  const changes: UserSections["Service"]["changes"] = Stream.unwrap(
    Effect.map(PubSub.subscribe(changed), (subscription) =>
      Stream.fromSubscription(subscription).pipe(
        Stream.prepend([undefined]),
        Stream.mapEffect(() => snapshot),
      ),
    ),
  );

  const contextOf = (current: State, projectId: string) =>
    current.contexts.find((context) => context.projectIds.some((id) => id === projectId))?.id;

  const childIds = (current: State, contextId: string, parentId: string | null) =>
    byPosition(
      current.sections.filter((row) => row.context_id === contextId && row.parent_id === parentId),
      (row) => row.id,
    ).map((row) => row.id);

  /** A context's projects in `sectionId` (null: its top level, where unplaced projects follow). */
  const projectIds = (current: State, contextId: string, sectionId: string | null) => {
    const inContext =
      current.contexts.find((context) => context.id === contextId)?.projectIds ?? [];
    const placed = byPosition(
      current.placements.filter(
        (row) => row.section_id === sectionId && inContext.some((id) => id === row.project_id),
      ),
      (row) => row.project_id,
    ).map((row) => row.project_id as ProjectId);
    if (sectionId !== null) return placed;
    const anywhere = new Set(current.placements.map((row) => row.project_id));
    return [...placed, ...inContext.filter((id) => !anywhere.has(id))];
  };

  const setSectionOrder = (parentId: string | null, ids: ReadonlyArray<string>) =>
    Effect.forEach(
      ids,
      (id, position) =>
        sql`UPDATE sections SET parent_id = ${parentId}, position = ${position} WHERE id = ${id}`,
      { discard: true },
    );

  const setProjectOrder = (sectionId: string | null, ids: ReadonlyArray<string>) =>
    Effect.forEach(
      ids,
      (id, position) =>
        sql`INSERT INTO project_placements (project_id, section_id, position)
          VALUES (${id}, ${sectionId}, ${position})
          ON CONFLICT (project_id) DO UPDATE SET section_id = excluded.section_id,
            position = excluded.position`,
      { discard: true },
    );

  /**
   * Decides and applies one change in a transaction; `decide` answers whether
   * anything changed. A change bumps the revision and reaches every subscriber.
   */
  const mutate = (decide: (current: State) => Effect.Effect<boolean, Failure>) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const changedAnything = yield* decide(yield* state);
          if (changedAnything) {
            yield* sql`UPDATE sections_state SET revision = revision + 1 WHERE id = 1`;
          }
          return changedAnything;
        }),
      )
      .pipe(
        Effect.tap((changedAnything) =>
          changedAnything ? PubSub.publish(changed, undefined) : Effect.void,
        ),
        Effect.andThen(snapshot),
      );

  const requireSection = (current: State, id: string) => {
    const row = current.sections.find((section) => section.id === id);
    return row ? Effect.succeed(row) : fail("section-not-found", "That section no longer exists.");
  };

  const create: UserSections["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const id = SectionId.make(yield* Effect.orDie(crypto.randomUUIDv4));
      return yield* mutate((current) =>
        Effect.gen(function* () {
          const parent =
            input.parentId === null ? null : yield* requireSection(current, input.parentId);
          // A top-level section without a context goes to Personal, where new threads start too.
          const contextId = parent?.context_id ?? input.contextId ?? PERSONAL_CONTEXT_ID;
          if (!current.contexts.some((context) => context.id === contextId)) {
            return yield* fail("invalid-move", "Choose one of your contexts for the section.");
          }
          if (input.contextId !== undefined && input.contextId !== contextId) {
            return yield* fail("invalid-move", "A subsection belongs to its parent's context.");
          }
          const siblings = childIds(current, contextId, input.parentId);
          const order = insertBefore(siblings, id, input.beforeId);
          if (order === undefined)
            return yield* fail("invalid-move", "That position is not a sibling.");
          yield* sql`INSERT INTO sections (id, context_id, parent_id, name, position)
            VALUES (${id}, ${contextId}, ${input.parentId}, ${input.name.trim()}, 0)`;
          yield* setSectionOrder(input.parentId, order);
          return true;
        }),
      );
    }).pipe(Effect.withSpan("UserSections.create"));

  const update: UserSections["Service"]["update"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const section = yield* requireSection(current, input.id);
        const pool =
          input.defaultPoolId === undefined
            ? { known: true, changed: false }
            : yield* bindings.setPool(
                { _tag: "section", sectionId: section.id },
                input.defaultPoolId,
              );
        if (!pool.known) return yield* fail("invalid-move", "Choose one of your pools.");
        const name = input.name?.trim();
        if (name === undefined || section.name === name) return pool.changed;
        yield* sql`UPDATE sections SET name = ${name} WHERE id = ${input.id}`;
        return true;
      }),
    ).pipe(Effect.withSpan("UserSections.update"));

  const move: UserSections["Service"]["move"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const moving = yield* requireSection(current, input.id);
        for (let cursor = input.parentId; cursor !== null;) {
          if (cursor === input.id)
            return yield* fail("invalid-move", "A section can't go inside itself.");
          const ancestor = yield* requireSection(current, cursor);
          if (ancestor.context_id !== moving.context_id) {
            return yield* fail("invalid-move", "Sections stay in their own context.");
          }
          cursor = ancestor.parent_id;
        }
        const source = childIds(current, moving.context_id, moving.parent_id);
        const target = childIds(current, moving.context_id, input.parentId);
        const sameParent = moving.parent_id === input.parentId;
        if (input.beforeId === input.id) {
          return sameParent
            ? false
            : yield* fail("invalid-move", "That position is not a sibling.");
        }
        const order = insertBefore(target, input.id, input.beforeId);
        if (order === undefined)
          return yield* fail("invalid-move", "That position is not a sibling.");
        if (sameParent && sameOrder(target, order)) return false;
        if (!sameParent)
          yield* setSectionOrder(
            moving.parent_id,
            source.filter((id) => id !== input.id),
          );
        yield* setSectionOrder(input.parentId, order);
        return true;
      }),
    ).pipe(Effect.withSpan("UserSections.move"));

  const remove: UserSections["Service"]["delete"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const deleting = yield* requireSection(current, input.id);
        const { context_id: contextId, parent_id: parentId } = deleting;
        // Its subsections take its place, its projects follow its parent's.
        const siblings = childIds(current, contextId, parentId);
        const at = Math.max(0, siblings.indexOf(input.id));
        const others = siblings.filter((id) => id !== input.id);
        const children = childIds(current, contextId, input.id);
        yield* setSectionOrder(parentId, [
          ...others.slice(0, at),
          ...children,
          ...others.slice(at),
        ]);
        yield* setProjectOrder(parentId, [
          ...projectIds(current, contextId, parentId),
          ...projectIds(current, contextId, input.id),
        ]);
        yield* sql`DELETE FROM sections WHERE id = ${input.id}`;
        // Its projects inherit from its parent now, like its pool's other levels.
        yield* bindings.setPool({ _tag: "section", sectionId: input.id }, null);
        return true;
      }),
    ).pipe(Effect.withSpan("UserSections.delete"));

  const moveProject: UserSections["Service"]["moveProject"] = (input) =>
    mutate((current) =>
      Effect.gen(function* () {
        const contextId = contextOf(current, input.projectId);
        if (contextId === undefined) {
          return yield* fail("project-not-found", "That project is not in any of your contexts.");
        }
        if (input.sectionId !== null) {
          const section = yield* requireSection(current, input.sectionId);
          if (section.context_id !== contextId) {
            return yield* fail("invalid-move", "Projects stay in their own context.");
          }
        }
        const sourceId =
          current.placements.find((row) => row.project_id === input.projectId)?.section_id ?? null;
        const source = projectIds(current, contextId, sourceId);
        const target = projectIds(current, contextId, input.sectionId);
        const sameSection = sourceId === input.sectionId;
        if (input.beforeProjectId === input.projectId) {
          return sameSection
            ? false
            : yield* fail("invalid-move", "That position is not a sibling.");
        }
        const order = insertBefore(target, input.projectId, input.beforeProjectId);
        if (order === undefined)
          return yield* fail("invalid-move", "That position is not a sibling.");
        if (sameSection && sameOrder(target, order)) return false;
        if (!sameSection) {
          yield* setProjectOrder(
            sourceId,
            source.filter((id) => id !== input.projectId),
          );
        }
        yield* setProjectOrder(input.sectionId, order);
        return true;
      }),
    ).pipe(Effect.withSpan("UserSections.moveProject"));

  const forgetPool: UserSections["Service"]["forgetPool"] = (poolId) =>
    Effect.gen(function* () {
      const forgotten = yield* sql.withTransaction(
        Effect.gen(function* () {
          if (!(yield* bindings.forgetPool(poolId))) return false;
          yield* sql`UPDATE sections_state SET revision = revision + 1 WHERE id = 1`;
          return true;
        }),
      );
      if (forgotten) yield* PubSub.publish(changed, undefined);
    });

  const pools: UserSections["Service"]["pools"] = Effect.map(state, poolsOf);

  const rows: UserSections["Service"]["rows"] = Effect.all({
    sections: sql`SELECT id, context_id, parent_id, name, position FROM sections`.pipe(
      Effect.map(decodeSectionRows),
    ),
    placements: sql`SELECT project_id, section_id, position FROM project_placements`.pipe(
      Effect.map(decodePlacementRows),
    ),
    bindings: bindings.rows,
  });

  const adopt: UserSections["Service"]["adopt"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          for (const row of input.sections) {
            yield* sql`INSERT INTO sections (id, context_id, parent_id, name, position)
              VALUES (${row.id}, ${row.context_id}, ${row.parent_id}, ${row.name}, ${row.position})
              ON CONFLICT (id) DO NOTHING`;
          }
          // Placements of projects this cloud doesn't have stay out of sight (`state`).
          for (const row of input.placements) {
            yield* sql`INSERT INTO project_placements (project_id, section_id, position)
              VALUES (${row.project_id}, ${row.section_id}, ${row.position})
              ON CONFLICT (project_id) DO NOTHING`;
          }
          yield* bindings.adopt(input.bindings ?? []);
          yield* sql`UPDATE sections_state SET revision = revision + 1 WHERE id = 1`;
        }),
      )
      .pipe(Effect.andThen(PubSub.publish(changed, undefined)), Effect.asVoid);

  return UserSections.of({
    snapshot,
    changes,
    create,
    update,
    move,
    delete: remove,
    moveProject,
    forgetPool,
    pools,
    rows,
    adopt,
  });
});

export const layer = Layer.effect(UserSections, make);
