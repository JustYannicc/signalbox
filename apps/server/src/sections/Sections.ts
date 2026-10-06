import { ProjectId } from "@t3tools/contracts";
import type {
  ProjectSectionChain,
  ProjectSectionPlacement,
  Section,
  SectionCreateInput,
  SectionDeleteInput,
  SectionId,
  SectionMoveInput,
  SectionProjectMoveInput,
  SectionUpdateInput,
  SectionsSnapshot,
} from "@t3tools/contracts/sections";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type { SectionError } from "./SectionsError.ts";
import {
  SectionInvalidMoveError,
  SectionInvalidNameError,
  SectionNotFoundError,
  SectionProjectNotFoundError,
  SectionStorageError,
  mapSectionStorageError,
} from "./SectionsError.ts";
import * as SectionsStore from "./SectionsStore.ts";

const validateName = (value: unknown): Effect.Effect<string, SectionInvalidNameError> => {
  if (typeof value !== "string") {
    return Effect.fail(new SectionInvalidNameError({ reason: "invalid-type" }));
  }
  const name = value.trim();
  if (name.length === 0) return Effect.fail(new SectionInvalidNameError({ reason: "empty" }));
  if (name.length > 128) return Effect.fail(new SectionInvalidNameError({ reason: "too-long" }));
  return Effect.succeed(name);
};

const insertBefore = <A extends string>(ids: ReadonlyArray<A>, id: A, beforeId?: A) => {
  const withoutMoving = ids.filter((candidate) => candidate !== id);
  const index = beforeId === undefined ? withoutMoving.length : withoutMoving.indexOf(beforeId);
  return index < 0
    ? undefined
    : [...withoutMoving.slice(0, index), id, ...withoutMoving.slice(index)];
};

const hasSameOrder = <A>(left: ReadonlyArray<A>, right: ReadonlyArray<A>) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const projectOrder = (
  sectionId: SectionId | null,
  placements: ReadonlyArray<ProjectSectionPlacement>,
  activeProjects: ReadonlyArray<ProjectId>,
) => {
  const explicit = placements
    .filter((placement) => placement.sectionId === sectionId)
    .slice()
    .sort(
      (left, right) =>
        left.position - right.position || left.projectId.localeCompare(right.projectId),
    )
    .map((placement) => placement.projectId);
  if (sectionId !== null) return explicit;

  const placedIds = new Set(placements.map((placement) => placement.projectId));
  return [...explicit, ...activeProjects.filter((projectId) => !placedIds.has(projectId))];
};

const requiredSection = (store: SectionsStore.SectionsTransaction, id: SectionId) =>
  store.section(id).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new SectionNotFoundError({ sectionId: id })),
        onSome: Effect.succeed,
      }),
    ),
  );

const ensureParent = (store: SectionsStore.SectionsTransaction, parentId: SectionId | null) =>
  parentId === null ? Effect.void : requiredSection(store, parentId).pipe(Effect.asVoid);

const invalidAnchor = (input: {
  readonly sectionId?: SectionId;
  readonly parentId: SectionId | null;
  readonly projectId?: ProjectId;
  readonly anchorId: string;
}) =>
  new SectionInvalidMoveError({
    reason: "anchor-not-sibling",
    ...(input.sectionId === undefined ? {} : { sectionId: input.sectionId }),
    parentId: input.parentId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    anchorId: input.anchorId,
  });

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const store = yield* SectionsStore.SectionsStore;

  const create: Sections["Service"]["create"] = (input) =>
    validateName(input.name).pipe(
      Effect.flatMap((name) =>
        crypto.randomUUIDv4.pipe(
          Effect.mapError((cause) => new SectionStorageError({ operation: "generate-id", cause })),
          Effect.flatMap((rawId) => {
            const id = rawId as SectionId;
            return store.mutate("create", (transaction) =>
              Effect.gen(function* () {
                yield* ensureParent(transaction, input.parentId);
                const siblings = (yield* transaction.children(input.parentId)).map(
                  (section) => section.id,
                );
                if (input.beforeId !== undefined && !siblings.includes(input.beforeId)) {
                  return yield* invalidAnchor({
                    sectionId: id,
                    parentId: input.parentId,
                    anchorId: input.beforeId,
                  });
                }
                const next = insertBefore(siblings, id, input.beforeId);
                yield* transaction.insertSection({
                  id,
                  name,
                  parentId: input.parentId,
                  position: 0,
                });
                yield* transaction.setSectionOrder(input.parentId, next ?? [...siblings, id]);
                return true;
              }),
            );
          }),
        ),
      ),
    );

  const update: Sections["Service"]["update"] = (input) =>
    validateName(input.name).pipe(
      Effect.flatMap((name) =>
        store.mutate("update", (transaction) =>
          Effect.gen(function* () {
            const current = yield* requiredSection(transaction, input.id);
            if (current.name === name) return false;
            yield* transaction.renameSection(input.id, name);
            return true;
          }),
        ),
      ),
    );

  const move: Sections["Service"]["move"] = (input: SectionMoveInput) =>
    store.mutate("move-section", (transaction) =>
      Effect.gen(function* () {
        const moving = yield* requiredSection(transaction, input.id);
        yield* ensureParent(transaction, input.parentId);
        const allSections = yield* transaction.sections;
        let ancestorId = input.parentId;
        while (ancestorId !== null) {
          if (ancestorId === input.id) {
            return yield* new SectionInvalidMoveError({
              reason: "cycle",
              sectionId: input.id,
              parentId: input.parentId,
            });
          }
          const ancestor = allSections.find((section) => section.id === ancestorId);
          if (!ancestor) return yield* new SectionNotFoundError({ sectionId: ancestorId });
          ancestorId = ancestor.parentId;
        }

        const sourceParent = moving.parentId;
        const sourceSiblings = (yield* transaction.children(sourceParent)).map(
          (section) => section.id,
        );
        const targetSiblings = (yield* transaction.children(input.parentId)).map(
          (section) => section.id,
        );
        const isSameParent = sourceParent === input.parentId;
        const targetWithoutMoving = targetSiblings.filter((id) => id !== input.id);
        if (
          input.beforeId !== undefined &&
          input.beforeId !== input.id &&
          !targetWithoutMoving.includes(input.beforeId)
        ) {
          return yield* invalidAnchor({
            sectionId: input.id,
            parentId: input.parentId,
            anchorId: input.beforeId,
          });
        }
        if (input.beforeId === input.id && !isSameParent) {
          return yield* invalidAnchor({
            sectionId: input.id,
            parentId: input.parentId,
            anchorId: input.beforeId,
          });
        }
        if (input.beforeId === input.id && isSameParent) return false;
        const next = insertBefore(targetSiblings, input.id, input.beforeId);
        const nextSiblings = next ?? [...targetWithoutMoving, input.id];
        if (isSameParent && hasSameOrder(targetSiblings, nextSiblings)) return false;
        if (!isSameParent) {
          yield* transaction.setSectionOrder(
            sourceParent,
            sourceSiblings.filter((id) => id !== input.id),
          );
        }
        yield* transaction.setSectionOrder(input.parentId, nextSiblings);
        return true;
      }),
    );

  const remove: Sections["Service"]["delete"] = (input: SectionDeleteInput) =>
    store.mutate("delete", (transaction) =>
      Effect.gen(function* () {
        const deleting = yield* requiredSection(transaction, input.id);
        const parentId = deleting.parentId;
        const siblings = (yield* transaction.children(parentId)).map((section) => section.id);
        const sectionIndex = siblings.indexOf(input.id);
        const existing = siblings.filter((id) => id !== input.id);
        const children = (yield* transaction.children(input.id)).map((section) => section.id);
        const insertAt = Math.max(0, sectionIndex);
        const nextSections = [
          ...existing.slice(0, insertAt),
          ...children,
          ...existing.slice(insertAt),
        ];
        const directProjects = yield* transaction.storedPlacements(input.id);
        const parentProjects = yield* transaction.storedPlacements(parentId);
        let rootImplicitProjects: ReadonlyArray<ProjectId> = [];
        if (parentId === null) {
          const activeProjects = yield* projects
            .listShells()
            .pipe(mapSectionStorageError("delete"));
          const activePlacements = yield* transaction.activePlacements;
          const placedIds = new Set(activePlacements.map((placement) => placement.projectId));
          rootImplicitProjects = activeProjects
            .map((project) => project.id)
            .filter((projectId) => !placedIds.has(projectId));
        }
        const nextProjects = [
          ...parentProjects.map((placement) => placement.projectId),
          ...rootImplicitProjects,
          ...directProjects.map((placement) => placement.projectId),
        ];
        yield* transaction.setSectionOrder(parentId, nextSections);
        yield* transaction.setProjectOrder(parentId, nextProjects);
        yield* transaction.deleteSection(input.id);
        return true;
      }),
    );

  const moveProject: Sections["Service"]["moveProject"] = (input: SectionProjectMoveInput) =>
    store.mutate("move-project", (transaction) =>
      Effect.gen(function* () {
        const activeProject = yield* projects
          .get(input.projectId)
          .pipe(mapSectionStorageError("move-project"));
        if (Option.isNone(activeProject)) {
          return yield* new SectionProjectNotFoundError({ projectId: input.projectId });
        }
        yield* ensureParent(transaction, input.sectionId);
        const { projects: activeProjects, placements } = yield* Effect.all({
          projects: projects.listShells().pipe(mapSectionStorageError("move-project")),
          placements: transaction.activePlacements,
        });
        const moving = placements.find((placement) => placement.projectId === input.projectId);
        const sourceSectionId = moving?.sectionId ?? null;
        const sourceSiblings = projectOrder(
          sourceSectionId,
          placements,
          activeProjects.map((p) => p.id),
        );
        const destinationSiblings = projectOrder(
          input.sectionId,
          placements,
          activeProjects.map((p) => p.id),
        );
        const sameSection = sourceSectionId === input.sectionId;
        const destinationWithoutMoving = destinationSiblings.filter(
          (projectId) => projectId !== input.projectId,
        );
        if (
          input.beforeProjectId !== undefined &&
          input.beforeProjectId !== input.projectId &&
          !destinationWithoutMoving.includes(input.beforeProjectId)
        ) {
          return yield* invalidAnchor({
            parentId: input.sectionId,
            projectId: input.projectId,
            anchorId: input.beforeProjectId,
          });
        }
        if (input.beforeProjectId === input.projectId && !sameSection) {
          return yield* invalidAnchor({
            parentId: input.sectionId,
            projectId: input.projectId,
            anchorId: input.beforeProjectId,
          });
        }
        if (input.beforeProjectId === input.projectId && sameSection) return false;
        const nextDestination = insertBefore(
          destinationSiblings,
          input.projectId,
          input.beforeProjectId,
        );
        const nextProjects = nextDestination ?? [...destinationWithoutMoving, input.projectId];
        if (sameSection && hasSameOrder(destinationSiblings, nextProjects)) return false;
        if (!sameSection) {
          yield* transaction.setProjectOrder(
            sourceSectionId,
            sourceSiblings.filter((projectId) => projectId !== input.projectId),
          );
        }
        yield* transaction.setProjectOrder(input.sectionId, nextProjects);
        return true;
      }),
    );

  const getProjectSectionChain: Sections["Service"]["getProjectSectionChain"] = (projectId) =>
    store.read("project-chain", (transaction) =>
      Effect.gen(function* () {
        const project = yield* projects
          .get(projectId)
          .pipe(mapSectionStorageError("project-chain"));
        if (Option.isNone(project)) {
          return yield* new SectionProjectNotFoundError({ projectId });
        }
        const placement = (yield* transaction.activePlacements).find(
          (candidate) => candidate.projectId === projectId,
        );
        if (placement === undefined || placement.sectionId === null) {
          return { section: null, ancestors: [] } satisfies ProjectSectionChain;
        }
        const allSections = yield* transaction.sections;
        const direct = allSections.find((section) => section.id === placement.sectionId);
        if (!direct) return yield* new SectionNotFoundError({ sectionId: placement.sectionId });
        const ancestors: Section[] = [];
        let ancestorId = direct.parentId;
        while (ancestorId !== null) {
          const ancestor = allSections.find((section) => section.id === ancestorId);
          if (!ancestor) return yield* new SectionNotFoundError({ sectionId: ancestorId });
          ancestors.push(ancestor);
          ancestorId = ancestor.parentId;
        }
        return { section: direct, ancestors } satisfies ProjectSectionChain;
      }),
    );

  return Sections.of({
    snapshot: store.snapshot,
    changes: store.changes,
    create,
    update,
    move,
    delete: remove,
    moveProject,
    getProjectSectionChain,
  });
});

export class Sections extends Context.Service<
  Sections,
  {
    readonly snapshot: Effect.Effect<SectionsSnapshot, SectionError>;
    readonly changes: Stream.Stream<SectionsSnapshot, SectionError>;
    readonly create: (input: SectionCreateInput) => Effect.Effect<SectionsSnapshot, SectionError>;
    readonly update: (input: SectionUpdateInput) => Effect.Effect<SectionsSnapshot, SectionError>;
    readonly move: (input: SectionMoveInput) => Effect.Effect<SectionsSnapshot, SectionError>;
    readonly delete: (input: SectionDeleteInput) => Effect.Effect<SectionsSnapshot, SectionError>;
    readonly moveProject: (
      input: SectionProjectMoveInput,
    ) => Effect.Effect<SectionsSnapshot, SectionError>;
    readonly getProjectSectionChain: (
      projectId: ProjectId,
    ) => Effect.Effect<ProjectSectionChain, SectionError>;
  }
>()("t3/sections/Sections") {}

export const layer = Layer.effect(Sections, make);
