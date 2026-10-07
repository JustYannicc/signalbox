import { ProjectId } from "@t3tools/contracts";
import type {
  ProjectSectionPlacement,
  Section,
  SectionId,
  SectionsSnapshot,
} from "@t3tools/contracts/sections";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";

import type { SectionStorageOperation } from "./SectionsError.ts";
import { SectionStorageError } from "./SectionsError.ts";

type SectionRow = {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly position: number;
};

type PlacementRow = {
  readonly projectId: string;
  readonly sectionId: string | null;
  readonly position: number;
};

export interface SectionsTransaction {
  readonly sections: Effect.Effect<ReadonlyArray<Section>, SqlError.SqlError>;
  readonly children: (
    parentId: SectionId | null,
  ) => Effect.Effect<ReadonlyArray<Section>, SqlError.SqlError>;
  readonly section: (id: SectionId) => Effect.Effect<Option.Option<Section>, SqlError.SqlError>;
  readonly activePlacements: Effect.Effect<
    ReadonlyArray<ProjectSectionPlacement>,
    SqlError.SqlError
  >;
  readonly storedPlacements: (
    sectionId: SectionId | null,
  ) => Effect.Effect<ReadonlyArray<ProjectSectionPlacement>, SqlError.SqlError>;
  readonly insertSection: (section: Section) => Effect.Effect<void, SqlError.SqlError>;
  readonly renameSection: (id: SectionId, name: string) => Effect.Effect<void, SqlError.SqlError>;
  readonly setSectionOrder: (
    parentId: SectionId | null,
    sectionIds: ReadonlyArray<SectionId>,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly setProjectOrder: (
    sectionId: SectionId | null,
    projectIds: ReadonlyArray<ProjectId>,
  ) => Effect.Effect<void, SqlError.SqlError>;
  readonly deleteSection: (id: SectionId) => Effect.Effect<void, SqlError.SqlError>;
}

const toSection = (row: SectionRow): Section => ({
  id: row.id as SectionId,
  name: row.name,
  parentId: row.parentId as SectionId | null,
  position: row.position,
});

const toPlacement = (row: PlacementRow): ProjectSectionPlacement => ({
  projectId: ProjectId.make(row.projectId),
  sectionId: row.sectionId as SectionId | null,
  position: row.position,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changed = yield* Effect.acquireRelease(
    PubSub.sliding<SectionsSnapshot>(1),
    PubSub.shutdown,
  );
  const gate = yield* Semaphore.make(1);

  yield* Effect.gen(function* () {
    yield* sql`
      CREATE TABLE IF NOT EXISTS signalbox_sections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_id TEXT REFERENCES signalbox_sections(id),
        position INTEGER NOT NULL CHECK (position >= 0)
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS signalbox_sections_parent_order
      ON signalbox_sections(parent_id, position, id)
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS signalbox_project_sections (
        project_id TEXT PRIMARY KEY REFERENCES projection_projects(project_id),
        section_id TEXT REFERENCES signalbox_sections(id),
        position INTEGER NOT NULL CHECK (position >= 0)
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS signalbox_project_sections_order
      ON signalbox_project_sections(section_id, position, project_id)
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS signalbox_sections_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0)
      )
    `;
    yield* sql`
      INSERT OR IGNORE INTO signalbox_sections_metadata(singleton, revision)
      VALUES (1, 0)
    `;
  }).pipe(Effect.mapError((cause) => new SectionStorageError({ operation: "initialize", cause })));

  const sections = sql<SectionRow>`
    SELECT id, name, parent_id AS "parentId", position
    FROM signalbox_sections
    ORDER BY COALESCE(parent_id, ''), position, id
  `.pipe(Effect.map((rows) => rows.map(toSection)));

  const children = (parentId: SectionId | null) =>
    (parentId === null
      ? sql<SectionRow>`
          SELECT id, name, parent_id AS "parentId", position
          FROM signalbox_sections
          WHERE parent_id IS NULL
          ORDER BY position, id
        `
      : sql<SectionRow>`
          SELECT id, name, parent_id AS "parentId", position
          FROM signalbox_sections
          WHERE parent_id = ${parentId}
          ORDER BY position, id
        `
    ).pipe(Effect.map((rows) => rows.map(toSection)));

  const section = (id: SectionId) =>
    sql<SectionRow>`
      SELECT id, name, parent_id AS "parentId", position
      FROM signalbox_sections
      WHERE id = ${id}
    `.pipe(Effect.map((rows) => Option.fromUndefinedOr(rows[0]).pipe(Option.map(toSection))));

  const activePlacements = sql<PlacementRow>`
    SELECT placement.project_id AS "projectId", placement.section_id AS "sectionId", placement.position
    FROM signalbox_project_sections placement
    JOIN projection_projects project ON project.project_id = placement.project_id
    WHERE project.deleted_at IS NULL
    ORDER BY COALESCE(placement.section_id, ''), placement.position, placement.project_id
  `.pipe(Effect.map((rows) => rows.map(toPlacement)));

  const storedPlacements = (sectionId: SectionId | null) =>
    (sectionId === null
      ? sql<PlacementRow>`
          SELECT project_id AS "projectId", section_id AS "sectionId", position
          FROM signalbox_project_sections
          WHERE section_id IS NULL
          ORDER BY position, project_id
        `
      : sql<PlacementRow>`
          SELECT project_id AS "projectId", section_id AS "sectionId", position
          FROM signalbox_project_sections
          WHERE section_id = ${sectionId}
          ORDER BY position, project_id
        `
    ).pipe(Effect.map((rows) => rows.map(toPlacement)));

  const setSectionOrder = (parentId: SectionId | null, ids: ReadonlyArray<SectionId>) =>
    Effect.forEach(
      ids,
      (id, position) => sql`
        UPDATE signalbox_sections
        SET parent_id = ${parentId}, position = ${position}
        WHERE id = ${id}
      `,
      { discard: true },
    );

  const setProjectOrder = (sectionId: SectionId | null, projectIds: ReadonlyArray<ProjectId>) =>
    Effect.forEach(
      projectIds,
      (projectId, position) => sql`
        INSERT INTO signalbox_project_sections(project_id, section_id, position)
        VALUES (${projectId}, ${sectionId}, ${position})
        ON CONFLICT(project_id) DO UPDATE SET
          section_id = excluded.section_id,
          position = excluded.position
      `,
      { discard: true },
    );

  const transaction = (): SectionsTransaction => ({
    sections,
    children,
    section,
    activePlacements,
    storedPlacements,
    insertSection: (entry) => sql`
      INSERT INTO signalbox_sections(id, name, parent_id, position)
      VALUES (${entry.id}, ${entry.name}, ${entry.parentId}, ${entry.position})
    `,
    renameSection: (id, name) =>
      sql`UPDATE signalbox_sections SET name = ${name} WHERE id = ${id}`.pipe(Effect.asVoid),
    setSectionOrder,
    setProjectOrder,
    deleteSection: (id) => sql`DELETE FROM signalbox_sections WHERE id = ${id}`.pipe(Effect.asVoid),
  });

  const readSnapshot = Effect.gen(function* () {
    const [revisionRows, allSections, placements] = yield* Effect.all(
      [
        sql<{ readonly revision: number }>`
          SELECT revision FROM signalbox_sections_metadata WHERE singleton = 1
        `,
        sections,
        activePlacements,
      ],
      { concurrency: "unbounded" },
    );
    const groups = new Map<string | null, ProjectSectionPlacement[]>();
    for (const placement of placements) {
      const group = groups.get(placement.sectionId) ?? [];
      group.push(placement);
      groups.set(placement.sectionId, group);
    }

    const projectPlacements: ProjectSectionPlacement[] = [];
    for (const [sectionId, group] of groups) {
      group
        .slice()
        .sort(
          (left, right) =>
            left.position - right.position || left.projectId.localeCompare(right.projectId),
        )
        .forEach((placement, position) =>
          projectPlacements.push({ ...placement, position, sectionId }),
        );
    }
    return {
      revision: revisionRows[0]?.revision ?? 0,
      sections: allSections,
      projectPlacements,
    } satisfies SectionsSnapshot;
  });

  const snapshot: SectionsStore["Service"]["snapshot"] = sql
    .withTransaction(readSnapshot)
    .pipe(
      Effect.mapError((cause) => new SectionStorageError({ operation: "read-snapshot", cause })),
    );

  const read: SectionsStore["Service"]["read"] = (operation, use) =>
    sql
      .withTransaction(use(transaction()))
      .pipe(
        Effect.mapError((cause) =>
          SqlError.isSqlError(cause) ? new SectionStorageError({ operation, cause }) : cause,
        ),
      );

  const mutate: SectionsStore["Service"]["mutate"] = (operation, use) =>
    gate.withPermit(
      Effect.uninterruptible(
        sql
          .withTransaction(
            Effect.gen(function* () {
              const didChange = yield* use(transaction());
              if (!didChange) return { didChange, snapshot: yield* readSnapshot };
              yield* sql`
                  UPDATE signalbox_sections_metadata
                  SET revision = revision + 1
                  WHERE singleton = 1
                `;
              return { didChange, snapshot: yield* readSnapshot };
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              SqlError.isSqlError(cause) ? new SectionStorageError({ operation, cause }) : cause,
            ),
            Effect.flatMap(({ didChange, snapshot }) =>
              didChange
                ? PubSub.publish(changed, snapshot).pipe(Effect.as(snapshot))
                : Effect.succeed(snapshot),
            ),
          ),
      ),
    );

  const changes = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changed);
      const first = yield* snapshot;
      return Stream.concat(
        Stream.make(first),
        Stream.fromSubscription(subscription).pipe(
          Stream.filter((next) => next.revision > first.revision),
        ),
      );
    }),
  );

  return SectionsStore.of({ snapshot, changes, read, mutate });
});

export class SectionsStore extends Context.Service<
  SectionsStore,
  {
    readonly snapshot: Effect.Effect<SectionsSnapshot, SectionStorageError>;
    readonly changes: Stream.Stream<SectionsSnapshot, SectionStorageError>;
    readonly read: <A, E>(
      operation: SectionStorageOperation,
      use: (transaction: SectionsTransaction) => Effect.Effect<A, E | SqlError.SqlError>,
    ) => Effect.Effect<A, E | SectionStorageError>;
    readonly mutate: <E>(
      operation: SectionStorageOperation,
      use: (transaction: SectionsTransaction) => Effect.Effect<boolean, E | SqlError.SqlError>,
    ) => Effect.Effect<SectionsSnapshot, E | SectionStorageError>;
  }
>()("t3/sections/SectionsStore") {}

export const layer = Layer.effect(SectionsStore, make);
