import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ProjectId } from "@t3tools/contracts";
import { AccountPoolId } from "@t3tools/contracts/accountHub";
import type { SectionId } from "@t3tools/contracts/sections";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Sections from "./Sections.ts";
import * as SectionsStore from "./SectionsStore.ts";

const sectionsLayer = Sections.layer.pipe(
  Layer.provideMerge(SectionsStore.layer),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeCrypto.layer),
);

const createdAt = "2026-01-01T00:00:00.000Z";

const createProject = (
  projects: ProjectStore.ProjectStoreV2["Service"],
  id: ProjectId,
  timestamp = createdAt,
) =>
  projects.apply({
    sequence: 1,
    eventId: EventId.make(`event-${id}`),
    aggregateKind: "project",
    aggregateId: id,
    occurredAt: timestamp,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: id,
      title: id,
      workspaceRoot: `/tmp/${id}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });

const namedSection = (sections: Sections.Sections["Service"], name: string) =>
  sections.snapshot.pipe(
    Effect.map((snapshot) => {
      const section = snapshot.sections.find((candidate) => candidate.name === name);
      assert.isDefined(section, `section ${name} should exist`);
      return section;
    }),
  );

it.layer(sectionsLayer)("Sections", (it) => {
  it.effect("nests and reorders sections while rejecting cycles", () =>
    Effect.gen(function* () {
      const sections = yield* Sections.Sections;
      const initial = yield* sections.snapshot;
      const alphaSnapshot = yield* sections.create({ name: "Alpha", parentId: null });
      assert.strictEqual(alphaSnapshot.revision, initial.revision + 1);
      const alpha = alphaSnapshot.sections.find((section) => section.name === "Alpha")!;
      const invalidName = yield* Effect.flip(sections.create({ name: "   ", parentId: null }));
      assert.strictEqual(invalidName._tag, "SectionInvalidNameError");
      const betaSnapshot = yield* sections.create({
        name: "Beta",
        parentId: null,
        beforeId: alpha.id,
      });
      const beta = betaSnapshot.sections.find((section) => section.name === "Beta")!;
      const gammaSnapshot = yield* sections.create({ name: "Gamma", parentId: null });
      const gamma = gammaSnapshot.sections.find((section) => section.name === "Gamma")!;
      const childSnapshot = yield* sections.create({ name: "Child", parentId: alpha.id });
      const child = childSnapshot.sections.find((section) => section.name === "Child")!;

      assert.deepStrictEqual(
        betaSnapshot.sections
          .filter((section) => section.parentId === null)
          .map((section) => section.name),
        ["Beta", "Alpha"],
      );
      assert.deepStrictEqual(child.parentId, alpha.id);

      const beforeInvalidMove = yield* sections.snapshot;
      const selfAnchor = yield* Effect.flip(
        sections.move({ id: alpha.id, parentId: beta.id, beforeId: alpha.id }),
      );
      assert.strictEqual(selfAnchor._tag, "SectionInvalidMoveError");
      const invalidSibling = yield* Effect.flip(
        sections.move({ id: child.id, parentId: beta.id, beforeId: gamma.id }),
      );
      assert.strictEqual(invalidSibling._tag, "SectionInvalidMoveError");
      const afterInvalidMoves = yield* sections.snapshot;
      assert.strictEqual(afterInvalidMoves.revision, beforeInvalidMove.revision);

      const nested = yield* sections.move({ id: alpha.id, parentId: beta.id });
      const nestedAlpha = nested.sections.find((section) => section.id === alpha.id)!;
      const nestedChild = nested.sections.find((section) => section.id === child.id)!;
      assert.strictEqual(nestedAlpha.parentId, beta.id);
      assert.strictEqual(nestedChild.parentId, alpha.id);

      const lifted = yield* sections.move({
        id: alpha.id,
        parentId: null,
        beforeId: gamma.id,
      });
      const liftedChild = lifted.sections.find((section) => section.id === child.id)!;
      assert.strictEqual(liftedChild.parentId, alpha.id);
      assert.deepStrictEqual(
        lifted.sections.filter((section) => section.parentId === null).map((section) => section.id),
        [beta.id, alpha.id, gamma.id],
      );

      const beforeReorder = yield* sections.snapshot;
      const reordered = yield* sections.move({
        id: alpha.id,
        parentId: null,
        beforeId: beta.id,
      });
      assert.strictEqual(reordered.revision, beforeReorder.revision + 1);
      assert.deepStrictEqual(
        reordered.sections
          .filter((section) => section.parentId === null)
          .map((section) => section.id),
        [alpha.id, beta.id, gamma.id],
      );

      const cycle = yield* Effect.flip(sections.move({ id: alpha.id, parentId: child.id }));
      assert.strictEqual(cycle._tag, "SectionInvalidMoveError");
      assert.strictEqual((yield* namedSection(sections, "Alpha")).parentId, null);

      const beforeRename = yield* sections.snapshot;
      const renamed = yield* sections.update({ id: child.id, name: "  Nested  " });
      assert.strictEqual(
        renamed.sections.find((section) => section.id === child.id)?.name,
        "Nested",
      );
      assert.strictEqual(renamed.revision, beforeRename.revision + 1);

      const sameName = yield* sections.update({ id: child.id, name: " Nested " });
      assert.strictEqual(sameName.revision, renamed.revision);
      const selfAnchored = yield* sections.move({
        id: alpha.id,
        parentId: null,
        beforeId: alpha.id,
      });
      assert.strictEqual(selfAnchored.revision, renamed.revision);
      const appendedLast = yield* sections.move({ id: gamma.id, parentId: null });
      assert.strictEqual(appendedLast.revision, renamed.revision);
    }),
  );

  it.effect("moves projects without changing them and reparents children on section deletion", () =>
    Effect.gen(function* () {
      const sections = yield* Sections.Sections;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const projectA = ProjectId.make("project-a");
      const projectB = ProjectId.make("project-b");
      const projectC = ProjectId.make("project-c");
      const projectD = ProjectId.make("project-d");
      yield* createProject(projects, projectA);
      yield* createProject(projects, projectB);
      yield* createProject(projects, projectC);

      const rootSnapshot = yield* sections.create({ name: "Root", parentId: null });
      const root = rootSnapshot.sections.find((section) => section.name === "Root")!;
      const childSnapshot = yield* sections.create({ name: "Child", parentId: root.id });
      const child = childSnapshot.sections.find((section) => section.name === "Child")!;
      const grandchildSnapshot = yield* sections.create({ name: "Grandchild", parentId: child.id });
      const grandchild = grandchildSnapshot.sections.find(
        (section) => section.name === "Grandchild",
      )!;

      const beforeProjectMove = yield* sections.snapshot;
      const placed = yield* sections.moveProject({
        projectId: projectA,
        sectionId: grandchild.id,
      });
      assert.strictEqual(placed.revision, beforeProjectMove.revision + 1);
      assert.deepStrictEqual(
        placed.projectPlacements.find((placement) => placement.projectId === projectA),
        { projectId: projectA, sectionId: grandchild.id, position: 0 },
      );
      assert.deepStrictEqual(
        placed.projectPlacements
          .filter((placement) => placement.sectionId === null)
          .map((placement) => placement.projectId),
        [projectB, projectC],
      );
      assert.deepStrictEqual(yield* sections.getProjectSectionChain(projectA), {
        section: grandchild,
        ancestors: [child, root],
      });

      const missingProject = yield* Effect.flip(
        sections.moveProject({
          projectId: ProjectId.make("project-missing"),
          sectionId: root.id,
        }),
      );
      assert.strictEqual(missingProject._tag, "SectionProjectNotFoundError");
      yield* sections.moveProject({ projectId: projectB, sectionId: child.id });
      const afterProjectMove = yield* sections.snapshot;
      const sameProjectOrder = yield* sections.moveProject({
        projectId: projectB,
        sectionId: child.id,
      });
      assert.strictEqual(sameProjectOrder.revision, afterProjectMove.revision);
      const projectSelfAnchor = yield* sections.moveProject({
        projectId: projectB,
        sectionId: child.id,
        beforeProjectId: projectB,
      });
      assert.strictEqual(projectSelfAnchor.revision, afterProjectMove.revision);

      const beforeDelete = yield* sections.snapshot;
      const deleted = yield* sections.delete({ id: child.id });
      assert.strictEqual(deleted.revision, beforeDelete.revision + 1);
      const movedGrandchild = deleted.sections.find((section) => section.id === grandchild.id)!;
      assert.strictEqual(movedGrandchild.parentId, root.id);
      assert.strictEqual(
        deleted.projectPlacements.find((placement) => placement.projectId === projectA)?.sectionId,
        grandchild.id,
      );
      assert.deepStrictEqual(yield* sections.getProjectSectionChain(projectA), {
        section: movedGrandchild,
        ancestors: [root],
      });
      assert.strictEqual(
        deleted.projectPlacements.find((placement) => placement.projectId === projectB)?.sectionId,
        root.id,
      );

      // A new unplaced project must stay after the already implicit root project.
      yield* createProject(projects, projectD);
      const deletedRoot = yield* sections.delete({ id: root.id });
      const movedToTopLevel = deletedRoot.sections.find((section) => section.id === grandchild.id)!;
      assert.strictEqual(movedToTopLevel.parentId, null);
      assert.deepStrictEqual(
        deletedRoot.projectPlacements
          .filter((placement) => placement.sectionId === null)
          .map((placement) => placement.projectId),
        [projectC, projectD, projectB],
      );
      assert.strictEqual(
        deletedRoot.projectPlacements.find((placement) => placement.projectId === projectB)
          ?.sectionId,
        null,
      );
      assert.deepStrictEqual(yield* sections.getProjectSectionChain(projectA), {
        section: movedToTopLevel,
        ancestors: [],
      });

      const deletedGrandchild = yield* sections.delete({ id: grandchild.id });
      assert.strictEqual(
        deletedGrandchild.projectPlacements.find((placement) => placement.projectId === projectA)
          ?.sectionId,
        null,
      );

      const movedToRoot = yield* sections.moveProject({
        projectId: projectA,
        sectionId: null,
        beforeProjectId: projectC,
      });
      assert.deepStrictEqual(
        movedToRoot.projectPlacements.map((placement) => placement.projectId),
        [projectA, projectC, projectD, projectB],
      );
      assert.ok(movedToRoot.projectPlacements.every((placement) => placement.sectionId === null));
      assert.deepStrictEqual(yield* sections.getProjectSectionChain(projectA), {
        section: null,
        ancestors: [],
      });
      const unchangedProject = yield* projects.get(projectA);
      assert.strictEqual(Option.isSome(unchangedProject), true);
      assert.strictEqual(Option.getOrNull(unchangedProject)?.workspaceRoot, `/tmp/${projectA}`);

      yield* projects.apply({
        sequence: 2,
        eventId: EventId.make("event-project-c-deleted"),
        aggregateKind: "project",
        aggregateId: projectC,
        occurredAt: "2026-01-02T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.deleted",
        payload: { projectId: projectC, deletedAt: "2026-01-02T00:00:00.000Z" },
      });
      const deletedProject = yield* Effect.flip(
        sections.moveProject({ projectId: projectC, sectionId: null }),
      );
      assert.strictEqual(deletedProject._tag, "SectionProjectNotFoundError");
    }),
  );

  it.effect("serializes concurrent section and project moves without duplicate placements", () =>
    Effect.gen(function* () {
      const sections = yield* Sections.Sections;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const projectIds = [
        ProjectId.make("project-concurrent-a"),
        ProjectId.make("project-concurrent-b"),
        ProjectId.make("project-concurrent-c"),
      ];
      yield* Effect.forEach(projectIds, (projectId) => createProject(projects, projectId));

      const destinationSnapshot = yield* sections.create({ name: "Destination", parentId: null });
      const destination = destinationSnapshot.sections.find(
        (section) => section.name === "Destination",
      )!;
      yield* Effect.all(
        ["A", "B", "C"].map((suffix) =>
          sections.create({ name: `Concurrent ${suffix}`, parentId: null }),
        ),
        { concurrency: "unbounded" },
      );

      const afterSectionCreates = yield* sections.snapshot;
      const roots = afterSectionCreates.sections
        .filter((section) => section.parentId === null)
        .slice()
        .sort((left, right) => left.position - right.position);
      assert.deepStrictEqual(
        roots.map((section) => section.position),
        roots.map((_, index) => index),
      );
      assert.strictEqual(new Set(roots.map((section) => section.id)).size, roots.length);

      yield* Effect.all(
        projectIds.map((projectId) =>
          sections.moveProject({ projectId, sectionId: destination.id }),
        ),
        { concurrency: "unbounded" },
      );
      const allPlacements = (yield* sections.snapshot).projectPlacements;
      const projectIdSet = new Set(projectIds);
      const placements = allPlacements.filter((placement) => projectIdSet.has(placement.projectId));
      assert.deepStrictEqual(
        placements.map((placement) => placement.projectId).sort(),
        projectIds.slice().sort(),
      );
      assert.deepStrictEqual(placements.map((placement) => placement.position).sort(), [0, 1, 2]);
      assert.ok(placements.every((placement) => placement.sectionId === destination.id));
      assert.strictEqual(
        new Set(allPlacements.map((placement) => placement.projectId)).size,
        allPlacements.length,
      );
    }),
  );

  it.effect("does not revise an unchanged root project order", () =>
    Effect.gen(function* () {
      const sections = yield* Sections.Sections;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const projectA = ProjectId.make("project-noop-a");
      const projectB = ProjectId.make("project-noop-b");
      const laterTimestamp = "2027-01-01T00:00:00.000Z";
      yield* createProject(projects, projectA, laterTimestamp);
      yield* createProject(projects, projectB, laterTimestamp);

      const rootSnapshot = yield* sections.create({ name: "Root", parentId: null });
      const beforeAppend = yield* sections.snapshot;
      const appendedLast = yield* sections.moveProject({ projectId: projectB, sectionId: null });
      assert.strictEqual(appendedLast.revision, rootSnapshot.revision);
      assert.deepStrictEqual(appendedLast.projectPlacements, beforeAppend.projectPlacements);

      const movedBefore = yield* sections.moveProject({
        projectId: projectB,
        sectionId: null,
        beforeProjectId: projectA,
      });
      assert.strictEqual(movedBefore.revision, rootSnapshot.revision + 1);
      const rootOrder = movedBefore.projectPlacements
        .filter((placement) => placement.sectionId === null)
        .map((placement) => placement.projectId);
      assert.ok(rootOrder.indexOf(projectB) < rootOrder.indexOf(projectA));
    }),
  );
});

it.live("keeps section snapshots and revisions after reopening the SQLite store", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "signalbox-sections-" });
    const databasePath = path.join(directory, "sections.sqlite");

    const firstDatabase = SqlitePersistence.layerFromPath(databasePath);
    const projectA = ProjectId.make("persistent-project-a");
    const projectB = ProjectId.make("persistent-project-b");
    const beforeRestart = yield* Effect.gen(function* () {
      const sections = yield* Sections.Sections;
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* createProject(projects, projectA);
      yield* createProject(projects, projectB);
      const rootSnapshot = yield* sections.create({ name: "Persistent", parentId: null });
      const root = rootSnapshot.sections.find((section) => section.name === "Persistent")!;
      const nestedSnapshot = yield* sections.create({ name: "Nested", parentId: root.id });
      const nested = nestedSnapshot.sections.find((section) => section.name === "Nested")!;
      yield* sections.moveProject({ projectId: projectB, sectionId: nested.id });
      return yield* sections.moveProject({
        projectId: projectA,
        sectionId: nested.id,
        beforeProjectId: projectB,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Sections.layer.pipe(
          Layer.provideMerge(SectionsStore.layer),
          Layer.provideMerge(ProjectStore.layer),
          Layer.provideMerge(firstDatabase),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    );

    const secondDatabase = SqlitePersistence.layerFromPath(databasePath);
    const afterRestart = yield* Effect.gen(function* () {
      const sections = yield* Sections.Sections;
      return {
        snapshot: yield* sections.snapshot,
        chain: yield* sections.getProjectSectionChain(projectA),
      };
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Sections.layer.pipe(
          Layer.provideMerge(SectionsStore.layer),
          Layer.provideMerge(ProjectStore.layer),
          Layer.provideMerge(secondDatabase),
          Layer.provide(NodeCrypto.layer),
        ),
      ),
    );

    assert.strictEqual(afterRestart.snapshot.revision, beforeRestart.revision);
    assert.deepStrictEqual(
      afterRestart.snapshot.sections.map((section) => ({
        name: section.name,
        parentId: section.parentId,
        position: section.position,
      })),
      [
        { name: "Persistent", parentId: null, position: 0 },
        { name: "Nested", parentId: beforeRestart.sections[0]!.id, position: 0 },
      ],
    );
    assert.deepStrictEqual(
      afterRestart.snapshot.projectPlacements.map((placement) => ({
        projectId: placement.projectId,
        sectionId: placement.sectionId,
        position: placement.position,
      })),
      [
        {
          projectId: projectA,
          sectionId: beforeRestart.sections[1]!.id,
          position: 0,
        },
        {
          projectId: projectB,
          sectionId: beforeRestart.sections[1]!.id,
          position: 1,
        },
      ],
    );
    assert.deepStrictEqual(afterRestart.chain, {
      section: beforeRestart.sections[1]!,
      ancestors: [beforeRestart.sections[0]!],
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// signalbox: a section's default pool, on a database from before sections had one.
it.live("adds the default pool to existing sections and keeps it through rename and restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "signalbox-section-pools-" });
    const databasePath = path.join(directory, "sections.sqlite");
    const layerAt = () =>
      Sections.layer.pipe(
        Layer.provideMerge(SectionsStore.layer),
        Layer.provideMerge(ProjectStore.layer),
        Layer.provideMerge(SqlitePersistence.layerFromPath(databasePath)),
        Layer.provide(NodeCrypto.layer),
      );

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE signalbox_sections (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          parent_id TEXT REFERENCES signalbox_sections(id),
          position INTEGER NOT NULL CHECK (position >= 0)
        )
      `;
      yield* sql`INSERT INTO signalbox_sections VALUES ('old', 'Old', NULL, 0)`;
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerFromPath(databasePath)));

    const sectionId = "old" as SectionId;
    const work = AccountPoolId.make("work");
    const project = ProjectId.make("pooled-project");
    const result = yield* Effect.gen(function* () {
      const sections = yield* Sections.Sections;
      yield* createProject(yield* ProjectStore.ProjectStoreV2, project);
      const before = yield* sections.snapshot;
      assert.deepStrictEqual(before.sections, [
        { id: sectionId, name: "Old", parentId: null, position: 0 },
      ]);
      const pooled = yield* sections.update({ id: sectionId, defaultPoolId: work });
      // Setting the same pool again is not a change.
      const unchanged = yield* sections.update({ id: sectionId, defaultPoolId: work });
      const renamed = yield* sections.update({ id: sectionId, name: "Renamed" });
      yield* sections.moveProject({ projectId: project, sectionId });
      return { before, pooled, unchanged, renamed };
    }).pipe(Effect.scoped, Effect.provide(layerAt()));

    assert.strictEqual(result.pooled.revision, result.before.revision + 1);
    assert.strictEqual(result.unchanged.revision, result.pooled.revision);
    assert.deepStrictEqual(result.renamed.sections[0], {
      id: sectionId,
      name: "Renamed",
      parentId: null,
      position: 0,
      defaultPoolId: work,
    });

    const afterRestart = yield* Effect.gen(function* () {
      const sections = yield* Sections.Sections;
      const chain = yield* sections.getProjectSectionChain(project);
      const cleared = yield* sections.update({ id: sectionId, defaultPoolId: null });
      return { chain, cleared };
    }).pipe(Effect.scoped, Effect.provide(layerAt()));

    assert.strictEqual(afterRestart.chain.section?.defaultPoolId, work);
    assert.deepStrictEqual(afterRestart.cleared.sections[0], {
      id: sectionId,
      name: "Renamed",
      parentId: null,
      position: 0,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
